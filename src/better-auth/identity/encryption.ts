const ENVELOPE_VERSION = "v1";
const ENCRYPTION_CONTEXT = "triad-encrypted-data:v1";
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

interface ParsedEncryptionSecrets {
  active: string;
  secrets: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEncryptionSecrets(serialized: string): ParsedEncryptionSecrets {
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("ENCRYPTION_SECRETS must be a JSON secret set");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("ENCRYPTION_SECRETS must contain valid JSON");
  }

  if (!isRecord(parsed) || typeof parsed.active !== "string") {
    throw new Error("ENCRYPTION_SECRETS must define an active secret ID");
  }
  if (!SECRET_ID_PATTERN.test(parsed.active)) {
    throw new Error("ENCRYPTION_SECRETS contains an invalid active secret ID");
  }
  if (!isRecord(parsed.secrets)) {
    throw new Error("ENCRYPTION_SECRETS must define keyed secret material");
  }

  const secrets: Record<string, string> = {};
  for (const [secretId, secret] of Object.entries(parsed.secrets)) {
    if (!SECRET_ID_PATTERN.test(secretId)) {
      throw new Error("ENCRYPTION_SECRETS contains an invalid secret ID");
    }
    if (typeof secret !== "string" || secret.length < 32 || secret.trim() !== secret) {
      throw new Error("ENCRYPTION_SECRETS values must contain at least 32 characters");
    }
    secrets[secretId] = secret;
  }

  if (Object.keys(secrets).length === 0 || !secrets[parsed.active]) {
    throw new Error("ENCRYPTION_SECRETS active secret is not configured");
  }

  return { active: parsed.active, secrets };
}

export function validateEncryptionSecrets(
  serialized: string,
  forbiddenSecrets: readonly string[] = [],
): void {
  const encryption = parseEncryptionSecrets(serialized);
  if (Object.values(encryption.secrets).some((secret) => forbiddenSecrets.includes(secret))) {
    throw new Error("ENCRYPTION_SECRETS must not reuse an identity or Better Auth secret");
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
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

function additionalData(secretId: string, context: string): Uint8Array {
  return new TextEncoder().encode(`${ENVELOPE_VERSION}:${secretId}:${context}`);
}

function validateContext(context: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(context)) {
    throw new Error("Encrypted data requires a valid context");
  }
}

async function encryptionKey(
  secret: string,
  secretId: string,
  context: string,
  usages: KeyUsage[],
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(ENCRYPTION_CONTEXT),
      info: new TextEncoder().encode(`${ENCRYPTION_CONTEXT}:${secretId}:${context}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function sealEncryptedData(
  serializedSecrets: string,
  context: string,
  value: unknown,
): Promise<string> {
  validateContext(context);
  const encryption = parseEncryptionSecrets(serializedSecrets);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(
    encryption.secrets[encryption.active],
    encryption.active,
    context,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(additionalData(encryption.active, context)),
    },
    key,
    arrayBuffer(new TextEncoder().encode(JSON.stringify(value))),
  );

  return [
    ENVELOPE_VERSION,
    encryption.active,
    base64UrlEncode(iv),
    base64UrlEncode(new Uint8Array(encrypted)),
  ].join(".");
}

export async function openEncryptedData(
  serializedSecrets: string,
  context: string,
  envelope: string,
): Promise<unknown> {
  validateContext(context);
  const encryption = parseEncryptionSecrets(serializedSecrets);
  const [version, secretId, encodedIv, encodedCiphertext] = envelope.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !secretId ||
    !encodedIv ||
    !encodedCiphertext ||
    !SECRET_ID_PATTERN.test(secretId) ||
    !encryption.secrets[secretId]
  ) {
    throw new Error("Invalid encrypted data envelope");
  }

  const iv = base64UrlDecode(encodedIv);
  if (iv.length !== 12) {
    throw new Error("Invalid encrypted data envelope");
  }

  let decrypted: ArrayBuffer;
  try {
    const key = await encryptionKey(encryption.secrets[secretId], secretId, context, ["decrypt"]);
    decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: arrayBuffer(iv),
        additionalData: arrayBuffer(additionalData(secretId, context)),
      },
      key,
      arrayBuffer(base64UrlDecode(encodedCiphertext)),
    );
  } catch {
    throw new Error("Unable to decrypt encrypted data");
  }

  try {
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error("Invalid encrypted data payload");
  }
}
