import { init } from "@paralleldrive/cuid2";

import { sha256Hex } from "./subjects";

const BASE_USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,23}$/;
const CANONICAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,23}_[a-z][a-z0-9]{5}$/;
const ACCOUNT_SUB_PATTERN = /^acc_([0-9a-f]{64})$/;
const USER_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PasskeyUsernameGeneratorOptions {
  random?: () => number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array {
  if (!USER_HANDLE_PATTERN.test(value)) {
    throw new Error("Passkey user handle is invalid");
  }

  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Passkey user handle is invalid");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error("Passkey user handle is invalid");
  }

  return bytes;
}

export function normalizePasskeyUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Passkey username is required");
  }

  const username = value.trim().toLowerCase();
  if (!BASE_USERNAME_PATTERN.test(username)) {
    throw new Error("Passkey username must use 3 to 24 letters, numbers, or hyphens");
  }

  return username;
}

export function canonicalPasskeyUsername(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_USERNAME_PATTERN.test(value)) {
    throw new Error("Canonical passkey username is invalid");
  }

  return value;
}

export function createPasskeyUsernameGenerator(
  options: PasskeyUsernameGeneratorOptions = {},
): (username: string) => string {
  const createSuffix = init({
    length: 6,
    ...(options.random ? { random: options.random } : {}),
  });

  return (username) => `${normalizePasskeyUsername(username)}_${createSuffix()}`;
}

export async function passkeyAccountSubject(username: string): Promise<string> {
  const canonicalUsername = canonicalPasskeyUsername(username);

  return `acc_${await sha256Hex(canonicalUsername)}`;
}

export async function passkeyWebAuthnUserId(username: string): Promise<string> {
  const accountSub = await passkeyAccountSubject(username);
  const match = ACCOUNT_SUB_PATTERN.exec(accountSub);
  if (!match) {
    throw new Error("Passkey account subject is invalid");
  }

  return base64Url(bytesFromHex(match[1]));
}

export function passkeyAccountSubjectFromUserHandle(userHandle: string): string {
  return `acc_${hex(base64UrlBytes(userHandle))}`;
}

export function passkeyDisplayName(username: string, createdAt = new Date()): string {
  const canonicalUsername = canonicalPasskeyUsername(username);
  const timestamp = createdAt.toISOString();

  return `${canonicalUsername} · ${timestamp.slice(0, 10)} ${timestamp.slice(11, 16)} UTC`;
}
