import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";
import { createTestDb } from "./d1";

const issuer = "https://auth.example";
const redirectUri = "http://localhost:3000/callback";
let signingPrivateJwk: string;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingPrivateJwk = JSON.stringify({ ...(await exportJWK(privateKey)), kid: "test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function testEnv(): Promise<Env> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ISSUER: issuer,
    SIGNING_PRIVATE_JWK: signingPrivateJwk,
    PAIRWISE_SECRET: "p".repeat(32),
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  };
}

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    client_id: "local-dev",
    redirect_uri: redirectUri,
    response_type: "code",
    provider: "github",
    state: "client-state",
    scope: "openid",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    ...overrides,
  });
  return `/authorize?${query}`;
}

async function beginConsent(env: Env, overrides: Record<string, string> = {}): Promise<{ request: string; csrf: string }> {
  const authorization = await app.request(authorizeUrl(overrides), undefined, env);
  expect(authorization.status).toBe(302);
  const request = new URL(authorization.headers.get("location")!).searchParams.get("request")!;
  const consent = await app.request(`/api/consent/${encodeURIComponent(request)}`, undefined, env);
  expect(consent.status).toBe(200);
  const body = await consent.json<{ csrf_token: string }>();
  return { request, csrf: body.csrf_token };
}

async function approveConsent(env: Env, request: string, csrf: string): Promise<string> {
  const response = await app.request(`/api/consent/${encodeURIComponent(request)}/approve`, {
    method: "POST",
    headers: {
      origin: issuer,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf_token: csrf }),
  }, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ redirect_to: string }>();
  return new URL(body.redirect_to).searchParams.get("state")!;
}

function stubGithub(id = 42) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary", token_type: "bearer", scope: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id, login: "mutable-name" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function issueAuthorizationCode(env: Env, verifier: string): Promise<string> {
  const { request, csrf } = await beginConsent(env, { code_challenge: await sha256(verifier) });
  const upstreamState = await approveConsent(env, request, csrf);
  stubGithub();
  const callback = await app.request(`/callback/github?state=${encodeURIComponent(upstreamState)}&code=provider-code`, undefined, env);
  expect(callback.status).toBe(302);
  return new URL(callback.headers.get("location")!).searchParams.get("code")!;
}

function tokenRequest(code: string, verifier?: string): RequestInit {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "local-dev",
    redirect_uri: redirectUri,
    code,
  });
  if (verifier !== undefined) body.set("code_verifier", verifier);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  };
}

describe("authorization-code routes", () => {
  it("mounts security headers on the root Hono application", async () => {
    const response = await app.request(authorizeUrl({ client_id: "unknown" }), undefined, await testEnv());

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it.each([
    ["unknown client", { client_id: "unknown" }],
    ["unregistered redirect", { redirect_uri: "https://evil.example/callback" }],
  ])("never redirects an invalid client: %s", async (_name, overrides) => {
    const response = await app.request(authorizeUrl(overrides), undefined, await testEnv());

    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["43 base64url characters", "a".repeat(43), 302],
    ["128 base64url characters", `${"a".repeat(126)}-_`, 302],
    ["129 characters", "a".repeat(129), 400],
    ["dot character", `${"a".repeat(42)}.`, 400],
    ["tilde character", `${"a".repeat(42)}~`, 400],
  ])("validates the PKCE challenge boundary: %s", async (_name, challenge, status) => {
    const response = await app.request(authorizeUrl({ code_challenge: challenge }), undefined, await testEnv());
    expect(response.status).toBe(status);
  });

  it("requires exact origin and one-time CSRF before consuming consent", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const path = `/api/consent/${encodeURIComponent(request)}/approve`;
    const body = (token: string) => new URLSearchParams({ csrf_token: token });

    const missingOrigin = await app.request(path, { method: "POST", body: body(csrf) }, env);
    expect(missingOrigin.status).toBe(403);

    const invalidCsrf = await app.request(path, {
      method: "POST",
      headers: { origin: issuer },
      body: body("wrong-token"),
    }, env);
    expect(invalidCsrf.status).toBe(403);

    const upstreamState = await approveConsent(env, request, csrf);
    expect(upstreamState).toHaveLength(43);

    const replay = await app.request(path, {
      method: "POST",
      headers: { origin: issuer },
      body: body(csrf),
    }, env);
    expect(replay.status).toBe(403);
  });

  it("consumes callback state before the upstream exchange", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const upstreamState = await approveConsent(env, request, csrf);
    const fetch = stubGithub();

    const first = await app.request(`/callback/github?state=${upstreamState}&code=provider-code`, undefined, env);
    expect(first.status).toBe(302);

    const replay = await app.request(`/callback/github?state=${upstreamState}&code=provider-code`, undefined, env);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires a valid 128-character verifier, consumes once, and rejects replay", async () => {
    const env = await testEnv();
    const verifier = `${"A-._~".repeat(25)}A-.`;
    expect(verifier).toHaveLength(128);
    const code = await issueAuthorizationCode(env, verifier);

    const missing = await app.request("/token", tokenRequest(code), env);
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const oversized = await app.request("/token", tokenRequest(code, `${verifier}A`), env);
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const exchanged = await app.request("/token", tokenRequest(code, verifier), env);
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    await expect(exchanged.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 600 });

    const replay = await app.request("/token", tokenRequest(code, verifier), env);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });
});
