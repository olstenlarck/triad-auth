import { validateProfileClaims } from "./claims";
import type { ProfileClaims, ProviderName } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const claimsSalt = encoder.encode("triad-auth-claims-v1");
const claimsInfo = encoder.encode("claims-encryption");
const claimsKeyIdPattern = /^[A-Za-z0-9_-]+$/;

interface ClaimsKeyring {
  active: string;
  keys: Record<string, string>;
  legacy?: string;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid encrypted claims");
  }

  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  if (base64url(bytes) !== value) {
    throw new Error("invalid encrypted claims");
  }

  return bytes;
}

function invalidClaimsKeyring(): Error {
  return new Error("invalid claims encryption keyring");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaimsKeyring(value: string): ClaimsKeyring {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidClaimsKeyring();
  }

  if (!isRecord(parsed) || typeof parsed.active !== "string" || !isRecord(parsed.keys)) {
    throw invalidClaimsKeyring();
  }
  if (!claimsKeyIdPattern.test(parsed.active)) {
    throw invalidClaimsKeyring();
  }

  const entries = Object.entries(parsed.keys);
  if (entries.length === 0 || entries.length > 2) {
    throw invalidClaimsKeyring();
  }
  if (
    entries.some(
      ([keyId, secret]) =>
        !claimsKeyIdPattern.test(keyId) || typeof secret !== "string" || secret.length < 32,
    )
  ) {
    throw invalidClaimsKeyring();
  }

  const keys = Object.fromEntries(entries) as Record<string, string>;
  if (!Object.hasOwn(keys, parsed.active)) {
    throw invalidClaimsKeyring();
  }
  if (
    parsed.legacy !== undefined &&
    (typeof parsed.legacy !== "string" || parsed.legacy.length < 32)
  ) {
    throw invalidClaimsKeyring();
  }

  return {
    active: parsed.active,
    keys,
    ...(parsed.legacy === undefined ? {} : { legacy: parsed.legacy }),
  };
}

async function claimsKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: claimsSalt, info: claimsInfo },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function versionedClaimsAdditionalData(prefix: string, context: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${prefix}\0${context}`);
}

async function decryptClaims(
  secret: string,
  additionalData: Uint8Array<ArrayBuffer>,
  encodedPayload: string,
): Promise<ProfileClaims> {
  const payload = decodeBase64url(encodedPayload);
  if (payload.length < 29) {
    throw new Error("invalid encrypted claims");
  }

  const key = await claimsKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: payload.slice(0, 12),
      additionalData,
      tagLength: 128,
    },
    key,
    payload.slice(12),
  );

  return validateProfileClaims(JSON.parse(decoder.decode(plaintext)));
}

export async function sealClaims(
  keyringJson: string,
  context: string,
  claims: ProfileClaims,
): Promise<string> {
  const keyring = parseClaimsKeyring(keyringJson);
  const prefix = `v2.${keyring.active}`;
  const key = await claimsKey(keyring.keys[keyring.active]);
  const validated = validateProfileClaims(claims);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: versionedClaimsAdditionalData(prefix, context),
        tagLength: 128,
      },
      key,
      encoder.encode(JSON.stringify(validated)),
    ),
  );

  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv);
  payload.set(ciphertext, iv.length);

  return `${prefix}.${base64url(payload)}`;
}

export async function openClaims(
  keyringJson: string,
  context: string,
  sealed: string,
): Promise<ProfileClaims> {
  const keyring = parseClaimsKeyring(keyringJson);

  if (sealed.startsWith("v1.")) {
    if (!keyring.legacy) {
      throw new Error("invalid encrypted claims");
    }

    return decryptClaims(keyring.legacy, encoder.encode(context), sealed.slice(3));
  }

  const match = /^v2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(sealed);
  if (!match) {
    throw new Error("invalid encrypted claims");
  }

  const [, keyId, encodedPayload] = match;
  if (!Object.hasOwn(keyring.keys, keyId)) {
    throw new Error("invalid encrypted claims");
  }
  const secret = keyring.keys[keyId];
  const prefix = `v2.${keyId}`;

  return decryptClaims(secret, versionedClaimsAdditionalData(prefix, context), encodedPayload);
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  return base64url(await hmacSha256Bytes(secret, value));
}

async function hmacSha256Bytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(value));

  return new Uint8Array(mac);
}

function hexadecimal(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pairwiseSubject(
  secret: string,
  accountId: string,
  clientId: string,
): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `pairwise-sub\0${accountId}\0${clientId}`);

  return `pws_${hexadecimal(digest)}`;
}

export async function accountSubject(
  secret: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `account-sub\0${provider}:${providerUserId}`);

  return `acc_${hexadecimal(digest)}`;
}

export async function providerSubject(
  secret: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `provider-sub\0${provider}:${providerUserId}`);

  return `pid_${provider}_${hexadecimal(digest)}`;
}

export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function makeUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let raw = "";

  for (const byte of bytes) {
    raw += alphabet[byte % alphabet.length];
  }

  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);

  if (aa.length !== bb.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }

  return diff === 0;
}
