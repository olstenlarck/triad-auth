import { base64url, fromBase64url } from "./util";

let secretsKey: Promise<CryptoKey> | undefined;

function key(raw: string): Promise<CryptoKey> {
  secretsKey ??= crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return secretsKey;
}

/** AES-256-GCM with the repository, environment, and name as associated data. */
export async function sealSecret(raw: string, context: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(raw),
    new TextEncoder().encode(value),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

export async function openSecret(raw: string, context: string, sealed: string): Promise<string> {
  const [, iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv), additionalData: new TextEncoder().encode(context) },
    await key(raw),
    fromBase64url(data),
  );
  return new TextDecoder().decode(plain);
}
