import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomId(length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) {
    out += BASE62[byte % 62];
  }

  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function sha256Hex(value: string | Uint8Array): string {
  return bytesToHex(sha256(typeof value === "string" ? encoder.encode(value) : value));
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}

const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;

export function isValidSlug(value: string): boolean {
  return SLUG.test(value) && !value.endsWith(".git") && value !== "." && value !== "..";
}

export function parseScopes(text: string): Set<string> {
  return new Set(text.split(/[\s,]+/).filter((scope) => scope.length > 0));
}

export function humanTime(seconds: number): string {
  const delta = now() - seconds;
  if (delta < 60) {
    return "just now";
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m ago`;
  }
  if (delta < 86_400) {
    return `${Math.floor(delta / 3600)}h ago`;
  }
  if (delta < 86_400 * 30) {
    return `${Math.floor(delta / 86_400)}d ago`;
  }

  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
