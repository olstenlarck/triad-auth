import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalScopeRequest,
  createPkce,
  devicePollDecision,
  fetchProviderCapabilities,
  verifyIdentityToken,
} from "../src/scripts/demo-protocol";

const brokerOrigin = "https://auth.example";
const issuer = `${brokerOrigin}/`;
const clientId = "triad-demo";
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "demo-key",
    use: "sig",
    alg: "ES256",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function token(overrides: {
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  kid?: string;
  pairwiseSub?: unknown;
  accountSub?: unknown;
  providerSub?: unknown;
  subject?: string;
  profileClaims?: Record<string, unknown>;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    pairwise_sub: overrides.pairwiseSub ?? "ps_demo",
    account_sub: overrides.accountSub ?? "acct_demo",
    provider_sub: overrides.providerSub ?? "prv_github_demo",
    ...overrides.profileClaims,
  })
    .setProtectedHeader({ alg: "ES256", kid: overrides.kid ?? "demo-key" })
    .setSubject(overrides.subject ?? "ps_demo")
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? clientId)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 600)
    .sign(privateKey);
}

function stubMetadata(keys: Record<string, unknown>[] = [publicJwk]) {
  const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${brokerOrigin}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${brokerOrigin}/authorize`,
        token_endpoint: `${brokerOrigin}/token`,
        device_authorization_endpoint: `${brokerOrigin}/device/code`,
        jwks_uri: `${brokerOrigin}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
        code_challenge_methods_supported: ["S256"],
        subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["ES256"],
      });
    }
    if (url === `${brokerOrigin}/.well-known/jwks.json`) return Response.json({ keys });
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("browser PKCE", () => {
  it("creates a 64-byte verifier, S256 challenge, and random state", async () => {
    const first = await createPkce();
    const second = await createPkce();
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(first.verifier),
    ));

    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(first.challenge).toBe(base64url(digest));
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.verifier).not.toBe(first.verifier);
    expect(second.state).not.toBe(first.state);
  });
});

describe("browser ID token verification", () => {
  it("fetches discovery and JWKS before returning verified identity claims", async () => {
    const fetch = stubMetadata();

    await expect(verifyIdentityToken(await token(), clientId, brokerOrigin)).resolves.toMatchObject({
      pairwiseSub: "ps_demo",
      accountSub: "acct_demo",
      providerSub: "prv_github_demo",
      issuer,
    });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      `${brokerOrigin}/.well-known/openid-configuration`,
      `${brokerOrigin}/.well-known/jwks.json`,
    ]);
  });

  it("passes one abort signal through discovery and JWKS verification requests", async () => {
    const fetch = stubMetadata();
    const controller = new AbortController();

    await verifyIdentityToken(await token(), clientId, brokerOrigin, controller.signal);

    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("rejects a token whose signing key does not match", async () => {
    stubMetadata();
    await expect(verifyIdentityToken(await token({ kid: "unknown" }), clientId, brokerOrigin))
      .rejects.toThrow("matching ES256 signing key");
  });

  it("rejects a token that does not declare ES256", async () => {
    stubMetadata();
    const now = Math.floor(Date.now() / 1000);
    const unsafe = await new SignJWT({
      pairwise_sub: "ps_demo",
      account_sub: "acct_demo",
      provider_sub: "github:42",
    })
      .setProtectedHeader({ alg: "HS256", kid: "demo-key" })
      .setSubject("ps_demo")
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode("not-a-public-key-secret-value-123"));

    await expect(verifyIdentityToken(unsafe, clientId, brokerOrigin))
      .rejects.toThrow("matching ES256 signing key");
  });

  it.each([
    ["issuer", { issuer: "https://evil.example/" }],
    ["audience", { audience: "other-client" }],
    ["expiry", { expiresAt: 1 }],
  ])("rejects an invalid %s", async (_name, overrides) => {
    stubMetadata();
    await expect(verifyIdentityToken(await token(overrides), clientId, brokerOrigin)).rejects.toThrow();
  });

  it.each([
    ["pairwise_sub", { pairwiseSub: 42 }],
    ["account_sub", { accountSub: 42 }],
    ["provider_sub", { providerSub: 42 }],
    ["subject", { subject: "different", pairwiseSub: "ps_demo" }],
  ])("rejects an invalid %s identity contract", async (_name, overrides) => {
    stubMetadata();
    await expect(verifyIdentityToken(await token(overrides), clientId, brokerOrigin))
      .rejects.toThrow("identity claims");
  });

  it("returns typed optional standard claims from a verified token", async () => {
    stubMetadata();

    const verified = await verifyIdentityToken(await token({
      profileClaims: {
        email: "dev@example.test",
        email_verified: true,
        preferred_username: "triad-dev",
        name: "Triad Developer",
        picture: "https://images.example/avatar.png",
      },
    }), clientId, brokerOrigin);

    expect(verified.profile).toEqual({
      email: "dev@example.test",
      emailVerified: true,
      handle: "triad-dev",
      name: "Triad Developer",
      avatar: "https://images.example/avatar.png",
    });
  });

  it.each([
    ["email", { email: 42 }],
    ["email_verified", { email: "dev@example.test", email_verified: "yes" }],
    ["preferred_username", { preferred_username: [] }],
    ["name", { name: {} }],
    ["picture", { picture: false }],
  ])("rejects a malformed optional %s claim", async (_name, profileClaims) => {
    stubMetadata();

    await expect(verifyIdentityToken(await token({ profileClaims }), clientId, brokerOrigin))
      .rejects.toThrow("profile claims");
  });
});

describe("provider capabilities", () => {
  it("loads enabled providers and their exact optional scopes", async () => {
    const fetch = vi.fn(async () => Response.json({
      providers: [
        { id: "google", scopes: ["email", "name", "avatar"] },
        { id: "twitter", scopes: ["handle", "name", "avatar"] },
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(fetchProviderCapabilities(brokerOrigin)).resolves.toEqual([
      { id: "google", scopes: ["email", "name", "avatar"] },
      { id: "twitter", scopes: ["handle", "name", "avatar"] },
    ]);
    expect(fetch).toHaveBeenCalledWith(new URL("/api/providers", brokerOrigin), { signal: undefined });
  });

  it("serializes selected supported scopes in canonical order", () => {
    const provider = { id: "github" as const, scopes: ["email", "handle", "name", "avatar"] as const };

    expect(canonicalScopeRequest(provider, ["avatar", "email", "email"])).toBe("openid email avatar");
    expect(() => canonicalScopeRequest(provider, ["unsupported"])).toThrow("unsupported scope");
  });
});

describe("device polling policy", () => {
  it("keeps the advertised interval while authorization is pending", () => {
    expect(devicePollDecision("authorization_pending", 5_000)).toEqual({
      continuePolling: true,
      intervalMs: 5_000,
      message: "Waiting for browser approval.",
    });
  });

  it("adds five seconds after a slow_down response", () => {
    expect(devicePollDecision("slow_down", 5_000)).toEqual({
      continuePolling: true,
      intervalMs: 10_000,
      message: "The broker asked this device to poll less often.",
    });
  });

  it.each([
    ["access_denied", "Authorization was denied in the browser."],
    ["expired_token", "This device code expired. Start a new device flow."],
    ["invalid_grant", "The device flow could not be completed. Start again."],
  ])("stops polling on %s", (error, message) => {
    expect(devicePollDecision(error, 5_000)).toEqual({
      continuePolling: false,
      intervalMs: 5_000,
      message,
    });
  });
});
