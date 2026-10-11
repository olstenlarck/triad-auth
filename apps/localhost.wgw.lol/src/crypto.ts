import { base64UrlDecode, base64UrlEncode, decoder, encoder, randomBytes } from "./utils";

async function aesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));

  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Environment secrets are stored as `v1.<iv>.<ciphertext>` with AES-256-GCM under ENCRYPTION_KEY.
export async function encryptText(secret: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptText(secret: string, envelope: string): Promise<string> {
  const [version, iv, ciphertext] = envelope.split(".");
  if (version !== "v1" || !iv || !ciphertext) {
    throw new Error("invalid secret envelope");
  }
  const key = await aesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(iv) },
    key,
    base64UrlDecode(ciphertext),
  );

  return decoder.decode(plaintext);
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return base64UrlEncode(new Uint8Array(signature));
}
