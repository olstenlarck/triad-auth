export type TriadProvider = "google" | "github" | "twitter";

const encoder = new TextEncoder();

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function accountSubject(
  secret: string,
  provider: TriadProvider,
  upstreamId: string,
): Promise<string> {
  return `acc_${hexadecimal(await hmac(secret, `account-sub\0${provider}:${upstreamId}`))}`;
}

export async function providerSubject(
  secret: string,
  provider: TriadProvider,
  upstreamId: string,
): Promise<string> {
  return `pid_${provider}_${hexadecimal(
    await hmac(secret, `provider-sub\0${provider}:${upstreamId}`),
  )}`;
}

export async function pairwiseSubject(
  secret: string,
  accountSub: string,
  clientId: string,
): Promise<string> {
  return `pws_${hexadecimal(
    await hmac(secret, `pairwise-sub\0${accountSub}\0${clientId}`),
  )}`;
}

export async function derivePrincipal(
  secret: string,
  provider: TriadProvider,
  upstreamId: string,
) {
  const [accountSub, providerSub] = await Promise.all([
    accountSubject(secret, provider, upstreamId),
    providerSubject(secret, provider, upstreamId),
  ]);
  return { accountSub, providerSub };
}
