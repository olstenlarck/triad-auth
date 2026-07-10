import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

export interface VerifiedIdentity {
  pairwiseSub: string;
  accountSub: string;
  providerSub: string;
  issuer: string;
  expiresAt: number;
}

export interface DevicePollDecision {
  continuePolling: boolean;
  intervalMs: number;
  message: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  jwks_uri: string;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("The broker metadata could not be loaded.");
  return response.json();
}

function discoveryDocument(value: unknown): DiscoveryDocument {
  if (!value || typeof value !== "object") throw new Error("The broker discovery document is invalid.");
  const candidate = value as Record<string, unknown>;
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "device_authorization_endpoint",
    "jwks_uri",
  ] as const) {
    if (typeof candidate[field] !== "string") throw new Error("The broker discovery document is invalid.");
  }
  return candidate as unknown as DiscoveryDocument;
}

export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge, state };
}

export function devicePollDecision(error: string, intervalMs: number): DevicePollDecision {
  if (error === "authorization_pending") {
    return { continuePolling: true, intervalMs, message: "Waiting for browser approval." };
  }
  if (error === "slow_down") {
    return {
      continuePolling: true,
      intervalMs: intervalMs + 5_000,
      message: "The broker asked this device to poll less often.",
    };
  }
  if (error === "access_denied") {
    return { continuePolling: false, intervalMs, message: "Authorization was denied in the browser." };
  }
  if (error === "expired_token") {
    return { continuePolling: false, intervalMs, message: "This device code expired. Start a new device flow." };
  }
  return { continuePolling: false, intervalMs, message: "The device flow could not be completed. Start again." };
}

export async function fetchDiscovery(
  brokerOrigin = location.origin,
  signal?: AbortSignal,
): Promise<DiscoveryDocument> {
  const endpoint = new URL("/.well-known/openid-configuration", brokerOrigin);
  return discoveryDocument(await json(await fetch(endpoint, { signal })));
}

export async function verifyIdentityToken(
  token: string,
  clientId: string,
  brokerOrigin = location.origin,
  signal?: AbortSignal,
): Promise<VerifiedIdentity> {
  const discovery = await fetchDiscovery(brokerOrigin, signal);
  const protectedHeader = decodeProtectedHeader(token);
  if (protectedHeader.alg !== "ES256" || typeof protectedHeader.kid !== "string") {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const jwks = await json(await fetch(discovery.jwks_uri, { signal }));
  const keys = jwks && typeof jwks === "object" && Array.isArray((jwks as { keys?: unknown }).keys)
    ? (jwks as { keys: Record<string, unknown>[] }).keys
    : [];
  const jwk = keys.find((candidate) =>
    candidate.kid === protectedHeader.kid
    && candidate.kty === "EC"
    && candidate.crv === "P-256"
    && candidate.use === "sig"
    && candidate.alg === "ES256"
  );
  if (!jwk) throw new Error("The token has no matching ES256 signing key.");

  const key = await importJWK(jwk as JsonWebKey, "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    issuer: discovery.issuer,
    audience: clientId,
  });
  if (
    typeof payload.sub !== "string"
    || typeof payload.pairwise_sub !== "string"
    || payload.sub !== payload.pairwise_sub
    || typeof payload.account_sub !== "string"
    || typeof payload.provider_sub !== "string"
    || typeof payload.exp !== "number"
  ) {
    throw new Error("The verified token has invalid identity claims.");
  }

  return {
    pairwiseSub: payload.pairwise_sub,
    accountSub: payload.account_sub,
    providerSub: payload.provider_sub,
    issuer: discovery.issuer,
    expiresAt: payload.exp,
  };
}
