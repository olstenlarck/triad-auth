export type IdentityProvider = "google" | "github" | "twitter";
export type AuthenticationProvider = IdentityProvider | "ethereum" | "passkey";

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);

  return hex(digest);
}

export async function ethereumUpstreamId(address: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Invalid Ethereum address");
  }

  return sha256Hex(address.toLowerCase());
}

export async function passkeyUpstreamId(publicKey: Uint8Array): Promise<string> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Passkey must contain a canonical P-256 public key");
  }

  return sha256Hex(publicKey);
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));

  return hex(digest);
}

export async function providerSubject(
  secret: string,
  provider: AuthenticationProvider,
  upstreamId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `provider-sub\0${provider}:${upstreamId}`);

  return `pid_${provider}_${digest}`;
}

export async function accountSubject(
  secret: string,
  provider: AuthenticationProvider,
  upstreamId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `account-sub\0${provider}:${upstreamId}`);

  return `acc_${digest}`;
}

export async function pairwiseSubject(
  secret: string,
  accountSub: string,
  clientId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `pairwise-sub\0${accountSub}\0${clientId}`);

  return `pws_${digest}`;
}
