export type IdentityProvider = "google" | "github" | "twitter";

const encoder = new TextEncoder();

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function providerSubject(
  secret: string,
  provider: IdentityProvider,
  upstreamId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `provider-sub\0${provider}:${upstreamId}`);

  return `pid_${provider}_${digest}`;
}

export async function accountSubject(
  secret: string,
  provider: IdentityProvider,
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
