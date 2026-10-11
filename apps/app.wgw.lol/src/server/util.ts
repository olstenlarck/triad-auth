export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const byte of bytes) {
    out += ID_ALPHABET[byte % 32];
  }
  return `${prefix}_${out}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Lowercase letters, digits, and single dashes, 1 to 39 characters. */
export function toHandle(value: string): string {
  const handle = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 39);
  return handle === "" ? "user" : handle;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    NAME_PATTERN.test(value) &&
    !value.endsWith(".git") &&
    value !== "." &&
    value !== ".."
  );
}
