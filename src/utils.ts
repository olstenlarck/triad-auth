export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function getArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);

  return copy.buffer;
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encrypted data encoding");
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid encrypted data encoding");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function boundedString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} must contain ${minimum} to ${maximum} characters`);
  }

  return value;
}

export function concatenateBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }

  return result;
}

export function uint32BigEndian(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

export function hexEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function responseError(body: unknown, fallback: string): Error {
  if (!isRecord(body)) {
    return new Error(fallback);
  }

  const message = body.error_description ?? body.message ?? body.error;

  return new Error(typeof message === "string" ? message : fallback);
}

export async function jsonResponse<Value>(response: Response, fallback: string): Promise<Value> {
  const body = (await response.json().catch(() => undefined)) as Value | undefined;
  if (!response.ok || body === undefined) {
    throw responseError(body, fallback);
  }

  return body;
}

export function isoDate(value: string | number | null | undefined, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const milliseconds = typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}
