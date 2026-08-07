import type { IdentityProvider } from "./subjects";

const SYNTHETIC_EMAIL_SUFFIX = "@identity.invalid";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const PROFILE_DATA_ENVELOPE_VERSION = "v1";
const PROFILE_DATA_CONTEXT = "triad-profile-data:v1";
const PROFILE_DATA_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export type ProfileScope = "email" | "handle" | "name" | "avatar";

export interface CapturedProfile {
  profileEmail?: string;
  profileEmailVerified?: boolean;
  profileHandle?: string;
  profileDisplayName?: string;
  profileAvatar?: string;
}

interface ParsedProfileDataKeyring {
  active: string;
  keys: Record<string, string>;
}

interface StoredProfileData {
  email?: string;
  email_verified?: boolean;
  handle?: string;
  name?: string;
  avatar_url?: string;
}

export interface ProfileIdentityUser {
  id: string;
  [key: string]: unknown;
}

export interface ProfileClaims {
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  picture?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();

  return normalized || undefined;
}

function emailAddress(value: unknown): string | undefined {
  const email = nonEmptyString(value);

  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}

function webUrl(value: unknown): string | undefined {
  const url = nonEmptyString(value);
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function parseProfileDataKeyring(serialized: string): ParsedProfileDataKeyring {
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("PROFILE_DATA_KEYRING must be a JSON keyring");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("PROFILE_DATA_KEYRING must contain valid JSON");
  }

  if (!isRecord(parsed) || typeof parsed.active !== "string") {
    throw new Error("PROFILE_DATA_KEYRING must define an active key ID");
  }
  if (!PROFILE_DATA_KEY_ID_PATTERN.test(parsed.active)) {
    throw new Error("PROFILE_DATA_KEYRING contains an invalid active key ID");
  }
  if (!isRecord(parsed.keys)) {
    throw new Error("PROFILE_DATA_KEYRING must define keyed encryption material");
  }

  const keys: Record<string, string> = {};
  for (const [keyId, key] of Object.entries(parsed.keys)) {
    if (!PROFILE_DATA_KEY_ID_PATTERN.test(keyId)) {
      throw new Error("PROFILE_DATA_KEYRING contains an invalid key ID");
    }
    if (typeof key !== "string" || key.length < 32 || key.trim() !== key) {
      throw new Error("PROFILE_DATA_KEYRING keys must contain at least 32 characters");
    }
    keys[keyId] = key;
  }

  if (Object.keys(keys).length === 0 || !keys[parsed.active]) {
    throw new Error("PROFILE_DATA_KEYRING active key is not configured");
  }

  return { active: parsed.active, keys };
}

export function validateProfileDataKeyring(
  serialized: string,
  forbiddenSecrets: readonly string[] = [],
): void {
  const keyring = parseProfileDataKeyring(serialized);
  if (Object.values(keyring.keys).some((key) => forbiddenSecrets.includes(key))) {
    throw new Error("PROFILE_DATA_KEYRING must not reuse an identity or Better Auth secret");
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid profile data encoding");
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid profile data encoding");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function profileEncryptionKey(keyMaterial: string, keyId: string, usages: KeyUsage[]) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyMaterial),
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(PROFILE_DATA_CONTEXT),
      info: new TextEncoder().encode(`${PROFILE_DATA_CONTEXT}:${keyId}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function profileDataFromCaptured(profile: CapturedProfile): StoredProfileData {
  const data: StoredProfileData = {};
  if (profile.profileEmail !== undefined) {
    data.email = profile.profileEmail;
  }
  if (profile.profileEmailVerified !== undefined) {
    data.email_verified = profile.profileEmailVerified;
  }
  if (profile.profileHandle !== undefined) {
    data.handle = profile.profileHandle;
  }
  if (profile.profileDisplayName !== undefined) {
    data.name = profile.profileDisplayName;
  }
  if (profile.profileAvatar !== undefined) {
    data.avatar_url = profile.profileAvatar;
  }

  return data;
}

function capturedFromProfileData(value: unknown): CapturedProfile {
  if (!isRecord(value)) {
    throw new Error("Invalid profile data payload");
  }

  const allowedFields = new Set(["email", "email_verified", "handle", "name", "avatar_url"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Invalid profile data payload");
  }

  const profile: CapturedProfile = {};
  if (value.email !== undefined) {
    if (typeof value.email !== "string") {
      throw new Error("Invalid profile email payload");
    }
    profile.profileEmail = value.email;
  }
  if (value.email_verified !== undefined) {
    if (typeof value.email_verified !== "boolean") {
      throw new Error("Invalid profile email verification payload");
    }
    profile.profileEmailVerified = value.email_verified;
  }
  if (value.handle !== undefined) {
    if (typeof value.handle !== "string") {
      throw new Error("Invalid profile handle payload");
    }
    profile.profileHandle = value.handle;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== "string") {
      throw new Error("Invalid profile name payload");
    }
    profile.profileDisplayName = value.name;
  }
  if (value.avatar_url !== undefined) {
    if (typeof value.avatar_url !== "string") {
      throw new Error("Invalid profile avatar payload");
    }
    profile.profileAvatar = value.avatar_url;
  }

  return profile;
}

function profileDataAdditionalData(keyId: string): Uint8Array {
  return new TextEncoder().encode(`${PROFILE_DATA_ENVELOPE_VERSION}:${keyId}`);
}

export async function sealProfileData(
  serializedKeyring: string,
  profile: CapturedProfile,
): Promise<string | undefined> {
  const keyring = parseProfileDataKeyring(serializedKeyring);
  const data = profileDataFromCaptured(profile);
  if (Object.keys(data).length === 0) {
    return undefined;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await profileEncryptionKey(keyring.keys[keyring.active], keyring.active, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as BufferSource,
      additionalData: profileDataAdditionalData(keyring.active) as unknown as BufferSource,
    },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );

  return [
    PROFILE_DATA_ENVELOPE_VERSION,
    keyring.active,
    base64UrlEncode(iv),
    base64UrlEncode(new Uint8Array(encrypted)),
  ].join(".");
}

export async function openProfileData(
  serializedKeyring: string,
  envelope: string,
): Promise<CapturedProfile> {
  const keyring = parseProfileDataKeyring(serializedKeyring);
  const [version, keyId, encodedIv, encodedCiphertext] = envelope.split(".");
  if (
    version !== PROFILE_DATA_ENVELOPE_VERSION ||
    !keyId ||
    !encodedIv ||
    !encodedCiphertext ||
    !PROFILE_DATA_KEY_ID_PATTERN.test(keyId) ||
    !keyring.keys[keyId]
  ) {
    throw new Error("Invalid profile data envelope");
  }

  const iv = base64UrlDecode(encodedIv);
  if (iv.length !== 12) {
    throw new Error("Invalid profile data envelope");
  }

  let decrypted: ArrayBuffer;
  try {
    const key = await profileEncryptionKey(keyring.keys[keyId], keyId, ["decrypt"]);
    decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as BufferSource,
        additionalData: profileDataAdditionalData(keyId) as unknown as BufferSource,
      },
      key,
      base64UrlDecode(encodedCiphertext) as unknown as BufferSource,
    );
  } catch {
    throw new Error("Unable to decrypt profile data");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error("Invalid profile data payload");
  }

  return capturedFromProfileData(parsed);
}

function googleProfile(profile: unknown): CapturedProfile {
  if (!isRecord(profile)) {
    return {};
  }

  const captured: CapturedProfile = {};
  const email = emailAddress(profile.email);
  if (email) {
    captured.profileEmail = email;
    if (typeof profile.email_verified === "boolean") {
      captured.profileEmailVerified = profile.email_verified;
    }
  }

  const displayName = nonEmptyString(profile.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(profile.picture);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

function githubProfile(profile: unknown): CapturedProfile {
  if (!isRecord(profile)) {
    return {};
  }

  const captured: CapturedProfile = {};
  const email = emailAddress(profile.email);
  if (email) {
    captured.profileEmail = email;
    captured.profileEmailVerified = false;
  }

  const handle = nonEmptyString(profile.login);
  if (handle) {
    captured.profileHandle = handle;
  }

  const displayName = nonEmptyString(profile.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(profile.avatar_url);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

function twitterProfile(profile: unknown): CapturedProfile {
  const data = isRecord(profile) && isRecord(profile.data) ? profile.data : undefined;
  if (!data) {
    return {};
  }

  const captured: CapturedProfile = {};
  const handle = nonEmptyString(data.username);
  if (handle) {
    captured.profileHandle = handle;
  }

  const displayName = nonEmptyString(data.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(data.profile_image_url);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

export function captureProviderProfile(
  provider: IdentityProvider,
  profile: unknown,
): CapturedProfile {
  if (provider === "google") {
    return googleProfile(profile);
  }
  if (provider === "github") {
    return githubProfile(profile);
  }

  return twitterProfile(profile);
}

async function resolveProfileClaims(
  user: CapturedProfile,
  scopes: readonly ProfileScope[],
): Promise<ProfileClaims> {
  const claims: ProfileClaims = {};

  if (scopes.includes("email")) {
    const email = emailAddress(user.profileEmail);
    if (email && !email.toLowerCase().endsWith(SYNTHETIC_EMAIL_SUFFIX)) {
      claims.email = email;
      if (typeof user.profileEmailVerified === "boolean") {
        claims.email_verified = user.profileEmailVerified;
      }
    }
  }

  if (scopes.includes("handle")) {
    const handle = nonEmptyString(user.profileHandle);
    if (handle) {
      claims.preferred_username = handle;
    }
  }

  if (scopes.includes("name")) {
    const displayName = nonEmptyString(user.profileDisplayName);
    if (displayName) {
      claims.name = displayName;
    }
  }

  if (scopes.includes("avatar")) {
    const avatar = webUrl(user.profileAvatar);
    if (avatar) {
      claims.picture = avatar;
    }
  }

  return claims;
}

export function createProfileClaimResolver(serializedKeyring: string) {
  validateProfileDataKeyring(serializedKeyring);

  return {
    resolveProfileClaims: async (user: ProfileIdentityUser, scopes: readonly ProfileScope[]) => {
      if (scopes.length === 0) {
        return {};
      }

      const profile =
        typeof user.profileData === "string"
          ? await openProfileData(serializedKeyring, user.profileData)
          : {};

      return resolveProfileClaims(profile, scopes);
    },
  };
}
