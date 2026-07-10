import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enabledProviders, finishProvider, startProvider } from "../src/providers";
import type { Env } from "../src/types";

const env = (overrides: Partial<Env> = {}) => ({
  ISSUER: "https://auth.example",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  TWITTER_CLIENT_ID: "twitter-client",
  TWITTER_CLIENT_SECRET: "twitter-secret",
  ...overrides,
} as Env);

let googlePrivateKey: CryptoKey;
let googlePublicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  googlePrivateKey = pair.privateKey;
  googlePublicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "google-test-key",
    use: "sig",
    alg: "RS256",
  };
});

afterEach(() => vi.unstubAllGlobals());

async function googleIdToken(claims: {
  issuer?: string;
  audience?: string;
  nonce?: string;
  subject?: string | null;
  issuedAt?: boolean;
  expiration?: boolean;
} = {}): Promise<string> {
  const token = new SignJWT({ nonce: claims.nonce ?? "google-nonce" })
    .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
    .setIssuer(claims.issuer ?? "https://accounts.google.com")
    .setAudience(claims.audience ?? "google-client");
  if (claims.issuedAt !== false) token.setIssuedAt();
  if (claims.expiration !== false) token.setExpirationTime("5m");
  if (claims.subject !== null) token.setSubject(claims.subject ?? "google-user-123");
  return token.sign(googlePrivateKey);
}

function stubGoogle(token: string) {
  const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "discarded-google-access-token",
        expires_in: 3599,
        scope: "openid",
        token_type: "Bearer",
        id_token: token,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [googlePublicJwk] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
        },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("provider configuration", () => {
  it("lists only providers with complete credential pairs in canonical order", () => {
    expect(enabledProviders(env())).toEqual(["google", "github", "twitter"]);
    expect(enabledProviders(env({ GOOGLE_CLIENT_SECRET: "" }))).toEqual(["github", "twitter"]);
    expect(enabledProviders(env({ GITHUB_CLIENT_ID: "" }))).toEqual(["google", "twitter"]);
    expect(enabledProviders(env({ TWITTER_CLIENT_SECRET: "" }))).toEqual(["google", "github"]);
  });

  it.each([
    ["google", { GOOGLE_CLIENT_SECRET: "" }],
    ["github", { GITHUB_CLIENT_ID: "" }],
    ["twitter", { TWITTER_CLIENT_SECRET: "" }],
  ] as const)("rejects an unconfigured %s adapter before redirect or exchange", async (provider, overrides) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(startProvider(provider, env(overrides), "state")).rejects.toThrow("not configured");
    await expect(finishProvider(provider, env(overrides), "code", "verifier", "nonce"))
      .rejects.toThrow("not configured");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Google provider", () => {
  it("starts OpenID Connect with the exact callback, openid-only scope, and a nonce", async () => {
    const start = await startProvider("google", env(), "upstream-state");
    const target = new URL(start.url);

    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: "google-client",
      redirect_uri: "https://auth.example/callback/google",
      response_type: "code",
      scope: "openid",
      state: "upstream-state",
      nonce: start.nonce,
    });
    expect(start.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.verifier).toBeUndefined();
  });

  it("verifies Google's remote-JWKS ID token and returns its immutable subject", async () => {
    const fetch = stubGoogle(await googleIdToken());

    await expect(finishProvider("google", env(), "provider-code", undefined, "google-nonce"))
      .resolves.toEqual({ provider: "google", id: "google-user-123" });

    const tokenRequest = fetch.mock.calls.find(([input]) => String(input) === "https://oauth2.googleapis.com/token");
    expect(tokenRequest).toBeDefined();
    const tokenInit = tokenRequest![1] as RequestInit;
    expect(tokenInit.method).toBe("POST");
    expect(new Headers(tokenInit.headers)).toEqual(new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    }));
    expect(String(tokenInit.body)).toBe(new URLSearchParams({
      code: "provider-code",
      client_id: "google-client",
      client_secret: "google-secret",
      redirect_uri: "https://auth.example/callback/google",
      grant_type: "authorization_code",
    }).toString());

    const jwksRequest = fetch.mock.calls.find(([input]) => String(input) === "https://www.googleapis.com/oauth2/v3/certs");
    expect(jwksRequest).toBeDefined();
  });

  it("rejects an ID token with the wrong nonce", async () => {
    stubGoogle(await googleIdToken({ nonce: "wrong-nonce" }));

    await expect(finishProvider("google", env(), "provider-code", undefined, "google-nonce"))
      .rejects.toThrow("nonce");
  });

  it.each([
    ["issuer", { issuer: "https://attacker.example" }],
    ["audience", { audience: "other-client" }],
  ] as const)("rejects an ID token with the wrong %s", async (_claim, claims) => {
    stubGoogle(await googleIdToken(claims));

    await expect(finishProvider("google", env(), "provider-code", undefined, "google-nonce"))
      .rejects.toMatchObject({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
  });

  it("rejects a verified Google ID token without an immutable subject", async () => {
    stubGoogle(await googleIdToken({ subject: null }));

    await expect(finishProvider("google", env(), "provider-code", undefined, "google-nonce"))
      .rejects.toThrow("subject");
  });

  it.each([
    ["expiration", { expiration: false }],
    ["issued-at", { issuedAt: false }],
  ] as const)("rejects an ID token without the required %s claim", async (_claim, claims) => {
    stubGoogle(await googleIdToken(claims));

    await expect(finishProvider("google", env(), "provider-code", undefined, "google-nonce"))
      .rejects.toMatchObject({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
  });
});

describe("GitHub provider", () => {
  it("starts authorization with the exact callback and no profile scopes", async () => {
    const start = await startProvider("github", env(), "upstream-state");
    const target = new URL(start.url);

    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: "github-client",
      redirect_uri: "https://auth.example/callback/github",
      state: "upstream-state",
    });
    expect(start.nonce).toBeUndefined();
    expect(start.verifier).toBeUndefined();
  });

  it("requests only GitHub identity and returns the immutable numeric id", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "temporary",
        token_type: "bearer",
        scope: "",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        login: "mutable-name",
        id: 42,
        node_id: "MDQ6VXNlcjQy",
        avatar_url: "https://avatars.example/42",
        gravatar_id: "",
        url: "https://api.github.com/users/mutable-name",
        html_url: "https://github.com/mutable-name",
        followers_url: "https://api.github.com/users/mutable-name/followers",
        following_url: "https://api.github.com/users/mutable-name/following{/other_user}",
        gists_url: "https://api.github.com/users/mutable-name/gists{/gist_id}",
        starred_url: "https://api.github.com/users/mutable-name/starred{/owner}{/repo}",
        subscriptions_url: "https://api.github.com/users/mutable-name/subscriptions",
        organizations_url: "https://api.github.com/users/mutable-name/orgs",
        repos_url: "https://api.github.com/users/mutable-name/repos",
        events_url: "https://api.github.com/users/mutable-name/events{/privacy}",
        received_events_url: "https://api.github.com/users/mutable-name/received_events",
        type: "User",
        site_admin: false,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(finishProvider("github", env(), "provider-code"))
      .resolves.toEqual({ provider: "github", id: "42" });

    const tokenRequest = fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenRequest[0]).toBe("https://github.com/login/oauth/access_token");
    expect(new Headers(tokenRequest[1].headers).get("accept")).toBe("application/json");
    expect(String(tokenRequest[1].body)).toBe(new URLSearchParams({
      code: "provider-code",
      client_id: "github-client",
      client_secret: "github-secret",
      redirect_uri: "https://auth.example/callback/github",
    }).toString());

    const identityRequest = fetch.mock.calls[1] as [string, RequestInit];
    expect(identityRequest[0]).toBe("https://api.github.com/user");
    const identityHeaders = new Headers(identityRequest[1].headers);
    expect(identityHeaders.get("authorization")).toBe("Bearer temporary");
    expect(identityHeaders.get("accept")).toBe("application/json");
    expect(identityHeaders.get("user-agent")).toBe("triad-auth");
  });

  it.each([NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null])("rejects an unsafe GitHub id: %s", async (id) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id }), { status: 200 })));

    await expect(finishProvider("github", env(), "provider-code")).rejects.toThrow("numeric id");
  });
});

describe("Twitter provider", () => {
  it("starts OAuth2 with the exact callback, minimum scopes, and upstream S256 PKCE", async () => {
    const start = await startProvider("twitter", env(), "upstream-state");
    const target = new URL(start.url);

    expect(target.origin + target.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      response_type: "code",
      client_id: "twitter-client",
      redirect_uri: "https://auth.example/callback/twitter",
      scope: "tweet.read users.read",
      state: "upstream-state",
      code_challenge: target.searchParams.get("code_challenge"),
      code_challenge_method: "S256",
    });
    expect(start.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(start.verifier));
    const binary = String.fromCharCode(...new Uint8Array(challenge));
    const expectedChallenge = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(target.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(start.nonce).toBeUndefined();
  });

  it("uses Basic client authentication and returns users-me immutable data.id", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "temporary-twitter-token",
        scope: "tweet.read users.read",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "2244994945", name: "Mutable Name", username: "mutable_name" },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(finishProvider("twitter", env(), "provider-code", "upstream-verifier"))
      .resolves.toEqual({ provider: "twitter", id: "2244994945" });

    const tokenRequest = fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenRequest[0]).toBe("https://api.x.com/2/oauth2/token");
    expect(new Headers(tokenRequest[1].headers)).toEqual(new Headers({
      accept: "application/json",
      authorization: `Basic ${btoa("twitter-client:twitter-secret")}`,
      "content-type": "application/x-www-form-urlencoded",
    }));
    expect(String(tokenRequest[1].body)).toBe(new URLSearchParams({
      code: "provider-code",
      grant_type: "authorization_code",
      redirect_uri: "https://auth.example/callback/twitter",
      code_verifier: "upstream-verifier",
    }).toString());

    const identityRequest = fetch.mock.calls[1] as [string, RequestInit];
    expect(identityRequest[0]).toBe("https://api.x.com/2/users/me");
    expect(new Headers(identityRequest[1].headers)).toEqual(new Headers({
      accept: "application/json",
      authorization: "Bearer temporary-twitter-token",
    }));
  });

  it.each([undefined, null, 42, "", "42.0", "-42"])(
    "rejects an invalid Twitter data.id: %s",
    async (id) => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id } }), { status: 200 })));

      await expect(finishProvider("twitter", env(), "provider-code", "upstream-verifier"))
        .rejects.toThrow("data.id");
    },
  );
});
