import { concat, decoder, encoder } from "./objects";

export const FLUSH_PKT = encoder.encode("0000");
export const DELIM_PKT = encoder.encode("0001");

export function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = (bytes.length + 4).toString(16).padStart(4, "0");

  return concat(encoder.encode(length), bytes);
}

export function pktLine(text: string): Uint8Array {
  return pkt(`${text}\n`);
}

export type Packet =
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "line"; payload: Uint8Array; text: string };

export class PktReader {
  offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.buffer.length;
  }

  // The bytes after the last packet consumed, for example the packfile that follows a flush.
  rest(): Uint8Array {
    return this.buffer.subarray(this.offset);
  }

  next(): Packet | null {
    if (this.offset + 4 > this.buffer.length) {
      return null;
    }

    const length = Number.parseInt(
      decoder.decode(this.buffer.subarray(this.offset, this.offset + 4)),
      16,
    );
    if (Number.isNaN(length)) {
      throw new Error("invalid pkt-line length");
    }
    if (length === 0) {
      this.offset += 4;
      return { kind: "flush" };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: "delim" };
    }
    if (length < 4 || this.offset + length > this.buffer.length) {
      throw new Error("truncated pkt-line");
    }

    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;

    return { kind: "line", payload, text: decoder.decode(payload).replace(/\n$/, "") };
  }

  // Reads lines until the next flush packet and returns their text.
  linesUntilFlush(): string[] {
    const lines: string[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null || packet.kind === "flush") {
        return lines;
      }
      if (packet.kind === "line") {
        lines.push(packet.text);
      }
    }
  }
}

// Side-band channel 1 carries pack data, 2 progress, 3 errors. Payloads are capped at 65515 bytes.
const SIDEBAND_MAX = 65_515;

export function sideband(channel: 1 | 2 | 3, payload: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += SIDEBAND_MAX) {
    const chunk = payload.subarray(offset, offset + SIDEBAND_MAX);
    packets.push(pkt(concat(new Uint8Array([channel]), chunk)));
  }
  if (payload.length === 0) {
    packets.push(pkt(new Uint8Array([channel])));
  }

  return packets;
}
