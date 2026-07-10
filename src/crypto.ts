import { validateProfileClaims } from "./claims";
import type { ProfileClaims, ProviderName } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const claimsSalt = encoder.encode("triad-auth-claims-v1");
const claimsInfo = encoder.encode("claims-encryption");

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encrypted claims");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("invalid encrypted claims");
  return bytes;
}

async function claimsKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("PAIRWISE_SECRET must be at least 32 characters");
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: claimsSalt, info: claimsInfo },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealClaims(secret: string, context: string, claims: ProfileClaims): Promise<string> {
  const key = await claimsKey(secret);
  const validated = validateProfileClaims(claims);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context), tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(validated)),
  ));
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv);
  payload.set(ciphertext, iv.length);
  return `v1.${base64url(payload)}`;
}

export async function openClaims(secret: string, context: string, sealed: string): Promise<ProfileClaims> {
  const key = await claimsKey(secret);
  if (!sealed.startsWith("v1.")) throw new Error("invalid encrypted claims");
  const payload = decodeBase64url(sealed.slice(3));
  if (payload.length < 29) throw new Error("invalid encrypted claims");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.slice(0, 12), additionalData: encoder.encode(context), tagLength: 128 },
    key,
    payload.slice(12),
  );
  return validateProfileClaims(JSON.parse(decoder.decode(plaintext)));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64url(new Uint8Array(mac));
}

export async function pairwiseSubject(secret: string, accountId: string, clientId: string): Promise<string> {
  return `ps_${await hmacSha256(secret, `${accountId}\0${clientId}`)}`;
}

export async function providerSubject(
  secret: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `provider-sub\0${provider}:${providerUserId}`);
  return `prv_${provider}_${digest.slice(0, 22)}`;
}

export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function makeUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let raw = "";
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
