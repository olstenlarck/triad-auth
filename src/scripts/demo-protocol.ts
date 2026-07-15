import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

export interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  issuer: string;
  jwks_uri: string;
  registration_endpoint: string;
  token_endpoint: string;
}

export interface InspectedOAuthQuery {
  clientId: string;
  oauthQuery: string;
  resources: string[];
  scopes: ["openid"];
}

export interface VerifiedIdentity {
  accountSub: string;
  expiresAt: number;
  issuer: string;
  pairwiseSub: string;
  providerSub: string;
}

interface AuthorizationRequestInput {
  authorizationEndpoint: string;
  callbackUrl: string;
  challenge: string;
  clientId: string;
  resource: string;
  state: string;
}

interface TokenExchangeInput {
  callbackUrl: string;
  clientId: string;
  code: string;
  resource: string;
  verifier: string;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error("The authorization server metadata could not be loaded.");
  }

  return response.json();
}

function authorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("The authorization server metadata is invalid.");
  }

  const candidate = value as Record<string, unknown>;
  for (const field of [
    "authorization_endpoint",
    "issuer",
    "jwks_uri",
    "registration_endpoint",
    "token_endpoint",
  ] as const) {
    if (typeof candidate[field] !== "string") {
      throw new Error("The authorization server metadata is invalid.");
    }
  }

  return candidate as unknown as AuthorizationServerMetadata;
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isIdentitySigningKey(candidate: Record<string, unknown>, kid: string): boolean {
  return (
    candidate.kid === kid &&
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    candidate.alg === "ES256" &&
    (candidate.use === undefined || candidate.use === "sig")
  );
}

export async function createPkce(): Promise<{
  challenge: string;
  state: string;
  verifier: string;
}> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));

  return { challenge, state, verifier };
}

export function authorizationRequest(input: AuthorizationRequestInput): URL {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.callbackUrl,
    scope: "openid",
    resource: input.resource,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();

  return url;
}

export function demoResourceFromIssuer(issuer: string): string {
  return new URL("/demo/", issuer).href;
}

export async function fetchDiscovery(
  origin = location.origin,
  signal?: AbortSignal,
): Promise<AuthorizationServerMetadata> {
  const endpoint = new URL("/api/auth/.well-known/openid-configuration", origin);

  return authorizationServerMetadata(await json(await fetch(endpoint, { signal })));
}

export function inspectOAuthQuery(search: string): InspectedOAuthQuery {
  const oauthQuery = search.startsWith("?") ? search.slice(1) : search;
  const query = new URLSearchParams(oauthQuery);
  const clientIds = query.getAll("client_id");
  const scopeValues = query.getAll("scope");
  const resources = query.getAll("resource");
  const validResources = resources.length > 0 && resources.every(absoluteHttpUrl);

  if (
    !oauthQuery ||
    clientIds.length !== 1 ||
    !clientIds[0] ||
    scopeValues.length !== 1 ||
    scopeValues[0] !== "openid" ||
    !validResources
  ) {
    throw new Error("The authorization request is invalid or unsupported.");
  }

  return {
    clientId: clientIds[0],
    oauthQuery,
    resources,
    scopes: ["openid"],
  };
}

export function tokenExchangeRequest(input: TokenExchangeInput): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    redirect_uri: input.callbackUrl,
    code: input.code,
    code_verifier: input.verifier,
    resource: input.resource,
  });
}

export async function verifyIdentityToken(
  token: string,
  clientId: string,
  origin = location.origin,
  signal?: AbortSignal,
): Promise<VerifiedIdentity> {
  const discovery = await fetchDiscovery(origin, signal);
  const protectedHeader = decodeProtectedHeader(token);
  const { alg, kid } = protectedHeader;

  if (alg !== "ES256" || typeof kid !== "string") {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const jwks = await json(await fetch(discovery.jwks_uri, { signal }));
  const keys =
    jwks && typeof jwks === "object" && Array.isArray((jwks as { keys?: unknown }).keys)
      ? (jwks as { keys: Record<string, unknown>[] }).keys
      : [];
  const jwk = keys.find((candidate) => isIdentitySigningKey(candidate, kid));

  if (!jwk) {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const key = await importJWK(jwk as JsonWebKey, "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    audience: clientId,
    issuer: discovery.issuer,
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
    accountSub: payload.account_sub,
    expiresAt: payload.exp,
    issuer: discovery.issuer,
    pairwiseSub: payload.pairwise_sub,
    providerSub: payload.provider_sub,
  };
}
