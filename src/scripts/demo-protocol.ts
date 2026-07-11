import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

export interface VerifiedIdentity {
  pairwiseSub: string;
  accountSub: string;
  providerSub: string;
  issuer: string;
  expiresAt: number;
  profile: VerifiedProfile;
}

export type ProviderName = "google" | "github" | "twitter";
export type ProfileScope = "email" | "handle" | "name" | "avatar";

export interface ProviderCapability {
  id: ProviderName;
  scopes: readonly ProfileScope[];
}

export interface VerifiedProfile {
  email?: string;
  emailVerified?: boolean;
  handle?: string;
  name?: string;
  avatar?: string;
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

const providerNames = new Set<ProviderName>(["google", "github", "twitter"]);
const profileScopeOrder: readonly ProfileScope[] = ["email", "handle", "name", "avatar"];

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error("The broker metadata could not be loaded.");
  }

  return response.json();
}

function discoveryDocument(value: unknown): DiscoveryDocument {
  if (!value || typeof value !== "object") {
    throw new Error("The broker discovery document is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "device_authorization_endpoint",
    "jwks_uri",
  ] as const) {
    if (typeof candidate[field] !== "string") {
      throw new Error("The broker discovery document is invalid.");
    }
  }

  return candidate as unknown as DiscoveryDocument;
}

function providerCapabilities(value: unknown): ProviderCapability[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { providers?: unknown }).providers)
  ) {
    throw new Error("The provider list is invalid.");
  }

  const seen = new Set<string>();

  return (value as { providers: unknown[] }).providers.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("The provider list is invalid.");
    }
    const { id, scopes } = value as { id?: unknown; scopes?: unknown };
    if (
      typeof id !== "string" ||
      !providerNames.has(id as ProviderName) ||
      seen.has(id) ||
      !Array.isArray(scopes) ||
      scopes.some(
        (scope) => typeof scope !== "string" || !profileScopeOrder.includes(scope as ProfileScope),
      ) ||
      new Set(scopes).size !== scopes.length
    ) {
      throw new Error("The provider list is invalid.");
    }
    seen.add(id);

    return { id: id as ProviderName, scopes: scopes as ProfileScope[] };
  });
}

function optionalString(payload: Record<string, unknown>, claim: string): string | undefined {
  const value = payload[claim];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The verified token has invalid profile claims.");
  }

  return value;
}

function verifiedProfile(payload: Record<string, unknown>): VerifiedProfile {
  const email = optionalString(payload, "email");
  const emailVerified = payload.email_verified;
  if (emailVerified !== undefined && (email === undefined || typeof emailVerified !== "boolean")) {
    throw new Error("The verified token has invalid profile claims.");
  }

  return {
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
    ...optionalValue("handle", optionalString(payload, "preferred_username")),
    ...optionalValue("name", optionalString(payload, "name")),
    ...optionalValue("avatar", optionalString(payload, "picture")),
  };
}

function optionalValue<Key extends keyof VerifiedProfile>(key: Key, value: VerifiedProfile[Key]) {
  return value === undefined ? {} : ({ [key]: value } as Pick<VerifiedProfile, Key>);
}

export async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
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
    return {
      continuePolling: false,
      intervalMs,
      message: "Authorization was denied in the browser.",
    };
  }
  if (error === "expired_token") {
    return {
      continuePolling: false,
      intervalMs,
      message: "This device code expired. Start a new device flow.",
    };
  }
  return {
    continuePolling: false,
    intervalMs,
    message: "The device flow could not be completed. Start again.",
  };
}

export async function fetchDiscovery(
  brokerOrigin = location.origin,
  signal?: AbortSignal,
): Promise<DiscoveryDocument> {
  const endpoint = new URL("/.well-known/openid-configuration", brokerOrigin);
  return discoveryDocument(await json(await fetch(endpoint, { signal })));
}

export async function fetchProviderCapabilities(
  brokerOrigin = location.origin,
  signal?: AbortSignal,
): Promise<ProviderCapability[]> {
  const endpoint = new URL("/api/providers", brokerOrigin);
  return providerCapabilities(await json(await fetch(endpoint, { signal })));
}

export function canonicalScopeRequest(
  provider: ProviderCapability,
  selected: readonly string[],
): string {
  const selectedScopes = new Set(selected);
  if ([...selectedScopes].some((scope) => !provider.scopes.includes(scope as ProfileScope))) {
    throw new Error("The selected provider does not support every selected scope.");
  }

  return ["openid", ...profileScopeOrder.filter((scope) => selectedScopes.has(scope))].join(" ");
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
  const keys =
    jwks && typeof jwks === "object" && Array.isArray((jwks as { keys?: unknown }).keys)
      ? (jwks as { keys: Record<string, unknown>[] }).keys
      : [];
  const jwk = keys.find(
    (candidate) =>
      candidate.kid === protectedHeader.kid &&
      candidate.kty === "EC" &&
      candidate.crv === "P-256" &&
      candidate.use === "sig" &&
      candidate.alg === "ES256",
  );
  if (!jwk) {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const key = await importJWK(jwk as JsonWebKey, "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    issuer: discovery.issuer,
    audience: clientId,
  });
  if (
    typeof payload.sub !== "string" ||
    typeof payload.pairwise_sub !== "string" ||
    payload.sub !== payload.pairwise_sub ||
    typeof payload.account_sub !== "string" ||
    typeof payload.provider_sub !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("The verified token has invalid identity claims.");
  }

  return {
    pairwiseSub: payload.pairwise_sub,
    accountSub: payload.account_sub,
    providerSub: payload.provider_sub,
    issuer: discovery.issuer,
    expiresAt: payload.exp,
    profile: verifiedProfile(payload),
  };
}
