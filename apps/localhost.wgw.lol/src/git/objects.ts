import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

export interface Person {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger?: Person;
  message: string;
}

export const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_FROM_PACK: Record<number, ObjectType | undefined> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export const MODE_DIR = "40000";
export const MODE_FILE = "100644";
export const MODE_EXEC = "100755";
export const MODE_LINK = "120000";
export const MODE_SUBMODULE = "160000";
export const EMPTY_SHA = "0000000000000000000000000000000000000000";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return encoder.encode(`${type} ${size}\0`);
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  const hash = sha1.create();
  hash.update(objectHeader(type, data.length));
  hash.update(data);

  return bytesToHex(hash.digest());
}

export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function formatPerson(person: Person): string {
  return `${person.name} <${person.email}> ${person.time} ${person.tz}`;
}

function parsePerson(value: string): Person {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(value);
  if (!match) {
    throw new Error(`invalid person line: ${value}`);
  }

  return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
}

export function parseCommit(data: Uint8Array): Commit {
  const text = decoder.decode(data);
  const split = text.indexOf("\n\n");
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);

  let tree: string | undefined;
  const parents: string[] = [];
  let author: Person | undefined;
  let committer: Person | undefined;
  // A continuation line (leading space) belongs to the previous header, for example a gpgsig.
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) {
      continue;
    }
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "tree") {
      tree = value;
    } else if (key === "parent") {
      parents.push(value);
    } else if (key === "author") {
      author = parsePerson(value);
    } else if (key === "committer") {
      committer = parsePerson(value);
    }
  }
  if (!tree || !author || !committer) {
    throw new Error("invalid commit object");
  }

  return { tree, parents, author, committer, message };
}

export function serializeCommit(commit: Commit): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(
    `author ${formatPerson(commit.author)}`,
    `committer ${formatPerson(commit.committer)}`,
  );

  return encoder.encode(`${lines.join("\n")}\n\n${commit.message}`);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    const mode = decoder.decode(data.subarray(offset, space));
    const name = decoder.decode(data.subarray(space + 1, nul));
    const sha = bytesToHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }

  return entries;
}

// Git sorts tree entries by name, with directories compared as if their name ended in "/".
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === MODE_DIR ? `${entry.name}/` : entry.name;
}

export function sortTree(entries: TreeEntry[]): TreeEntry[] {
  return entries.toSorted((a, b) => {
    const left = treeSortKey(a);
    const right = treeSortKey(b);
    if (left === right) {
      return 0;
    }

    return left < right ? -1 : 1;
  });
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of sortTree(entries)) {
    parts.push(encoder.encode(`${entry.mode} ${entry.name}\0`), hexToBytes(entry.sha));
  }

  return concat(...parts);
}

export function parseTag(data: Uint8Array): Tag {
  const text = decoder.decode(data);
  const split = text.indexOf("\n\n");
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);

  let object: string | undefined;
  let type: ObjectType | undefined;
  let name: string | undefined;
  let tagger: Person | undefined;
  for (const line of headerText.split("\n")) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "object") {
      object = value;
    } else if (key === "type") {
      // SAFETY: the type header names the kind of `object`, and git writes only the four object kinds there.
      type = value as ObjectType;
    } else if (key === "tag") {
      name = value;
    } else if (key === "tagger") {
      tagger = parsePerson(value);
    }
  }
  if (!object || !type || !name) {
    throw new Error("invalid tag object");
  }

  return { object, type, tag: name, tagger, message };
}

export function isBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8000);

  return sample.includes(0);
}
