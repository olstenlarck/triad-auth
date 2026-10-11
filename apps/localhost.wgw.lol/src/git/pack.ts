import { sha1 } from "@noble/hashes/legacy.js";
import { Inflate, deflate } from "pako";

import {
  type GitObject,
  type ObjectType,
  PACK_TYPE,
  TYPE_FROM_PACK,
  bytesToHex,
  concat,
  encoder,
  hashObject,
} from "./objects";

export interface PackedObject extends GitObject {
  sha: string;
  // The zlib stream exactly as it appeared in the pack, when the entry was not a delta.
  zdata?: Uint8Array;
}

export type BaseResolver = (sha: string) => Promise<GitObject | null>;

const OFS_DELTA = 6;
const REF_DELTA = 7;

function inflateAt(buffer: Uint8Array, offset: number): { data: Uint8Array; consumed: number } {
  const inflater = new Inflate();
  inflater.push(buffer.subarray(offset), true);
  if (inflater.err) {
    throw new Error(`pack inflate failed: ${inflater.msg}`);
  }

  // SAFETY: Inflate without `to: "string"` yields a Uint8Array; strm.next_in counts the compressed bytes consumed.
  return { data: inflater.result as Uint8Array, consumed: inflater.strm.next_in };
}

function readVarint(buffer: Uint8Array, start: number): { value: number; offset: number } {
  let offset = start;
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);

  return { value, offset };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let offset = 0;
  const sourceSize = readVarint(delta, offset);
  offset = sourceSize.offset;
  if (sourceSize.value !== base.length) {
    throw new Error("delta base size mismatch");
  }
  const targetSize = readVarint(delta, offset);
  offset = targetSize.offset;

  const target = new Uint8Array(targetSize.value);
  let written = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++];
    if (opcode & 0x80) {
      // Each flagged byte fills its own 8-bit slot of the little-endian offset and size.
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) {
        copyOffset += delta[offset++];
      }
      if (opcode & 0x02) {
        copyOffset += delta[offset++] * 2 ** 8;
      }
      if (opcode & 0x04) {
        copyOffset += delta[offset++] * 2 ** 16;
      }
      if (opcode & 0x08) {
        copyOffset += delta[offset++] * 2 ** 24;
      }
      if (opcode & 0x10) {
        copySize += delta[offset++];
      }
      if (opcode & 0x20) {
        copySize += delta[offset++] * 2 ** 8;
      }
      if (opcode & 0x40) {
        copySize += delta[offset++] * 2 ** 16;
      }
      if (copySize === 0) {
        copySize = 0x10000;
      }
      target.set(base.subarray(copyOffset, copyOffset + copySize), written);
      written += copySize;
    } else if (opcode > 0) {
      target.set(delta.subarray(offset, offset + opcode), written);
      offset += opcode;
      written += opcode;
    } else {
      throw new Error("invalid delta opcode");
    }
  }
  if (written !== target.length) {
    throw new Error("delta produced wrong size");
  }

  return target;
}

export function verifyPackChecksum(pack: Uint8Array): void {
  if (pack.length < 32) {
    throw new Error("pack too short");
  }

  const expected = bytesToHex(pack.subarray(-20));
  const actual = bytesToHex(sha1(pack.subarray(0, -20)));
  if (expected !== actual) {
    throw new Error("pack checksum mismatch");
  }
}

// Parses a packfile, resolving deltas against earlier entries or, for thin packs, the repository.
export async function parsePack(
  pack: Uint8Array,
  resolveBase: BaseResolver,
): Promise<PackedObject[]> {
  if (pack.length < 12 || String.fromCharCode(...pack.subarray(0, 4)) !== "PACK") {
    throw new Error("not a packfile");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported pack version ${version}`);
  }
  verifyPackChecksum(pack);
  const count = view.getUint32(8);

  const objects: PackedObject[] = [];
  const byOffset = new Map<number, PackedObject>();
  const bySha = new Map<string, PackedObject>();
  const deferred: Array<{ entryOffset: number; baseSha: string; delta: Uint8Array }> = [];
  let offset = 12;
  for (let index = 0; index < count; index++) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }

    let base: GitObject | null = null;
    if (typeCode === OFS_DELTA) {
      byte = pack[offset++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        distance = ((distance + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(entryOffset - distance) ?? null;
      if (!base) {
        throw new Error("ofs-delta base not found");
      }
    }
    let pendingBase: string | null = null;
    if (typeCode === REF_DELTA) {
      const baseSha = bytesToHex(pack.subarray(offset, offset + 20));
      offset += 20;
      base = bySha.get(baseSha) ?? (await resolveBase(baseSha));
      if (!base) {
        // A valid pack may place the base after its delta; resolve it once everything is read.
        pendingBase = baseSha;
      }
    }

    const { data: inflated, consumed } = inflateAt(pack, offset);
    const zdata = pack.subarray(offset, offset + consumed);
    offset += consumed;

    if (pendingBase) {
      deferred.push({ entryOffset, baseSha: pendingBase, delta: inflated });
      continue;
    }

    let object: PackedObject;
    if (base) {
      const data = applyDelta(base.data, inflated);
      object = { type: base.type, data, sha: hashObject(base.type, data) };
    } else {
      const type = TYPE_FROM_PACK[typeCode];
      if (!type) {
        throw new Error(`invalid object type ${typeCode}`);
      }
      if (inflated.length !== size) {
        throw new Error("object size mismatch");
      }
      object = { type, data: inflated, sha: hashObject(type, inflated), zdata };
    }
    objects.push(object);
    byOffset.set(entryOffset, object);
    bySha.set(object.sha, object);
  }

  // Forward ref-deltas: apply in passes until every base is known or nothing moves.
  let remaining = deferred;
  while (remaining.length > 0) {
    const next: typeof remaining = [];
    for (const entry of remaining) {
      const base = bySha.get(entry.baseSha) ?? (await resolveBase(entry.baseSha));
      if (!base) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.delta);
      const object: PackedObject = { type: base.type, data, sha: hashObject(base.type, data) };
      objects.push(object);
      byOffset.set(entry.entryOffset, object);
      bySha.set(object.sha, object);
    }
    if (next.length === remaining.length) {
      throw new Error(`ref-delta base ${next[0].baseSha} not found`);
    }
    remaining = next;
  }

  return objects;
}

export function packEntryHeader(type: ObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (PACK_TYPE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(byte);

  return new Uint8Array(bytes);
}

export interface PackSource {
  type: ObjectType;
  size: number;
  zdata: Uint8Array;
}

export function compress(data: Uint8Array): Uint8Array {
  return deflate(data);
}

// Streams a packfile: header, one undeltified entry per object, then the SHA-1 trailer.
export async function* writePack(
  count: number,
  entries: AsyncIterable<PackSource> | Iterable<PackSource>,
): AsyncGenerator<Uint8Array> {
  const hash = sha1.create();
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, count);
  hash.update(header);
  yield header;

  for await (const entry of entries) {
    const chunk = concat(packEntryHeader(entry.type, entry.size), entry.zdata);
    hash.update(chunk);
    yield chunk;
  }

  yield hash.digest();
}
