import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import { createCsrfToken } from "../src/security";
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

async function inspectConsent(env: Env, request: string): Promise<string> {
  const consent = await app.request(`/api/consent/${encodeURIComponent(request)}`, undefined, env);
  expect(consent.status).toBe(200);
  const body = await consent.json<{ csrf_token: string }>();
  return body.csrf_token;
}

async function beginConsent(env: Env, overrides: Record<string, string> = {}): Promise<{ request: string; csrf: string }> {
  const authorization = await app.request(authorizeUrl(overrides), undefined, env);
  expect(authorization.status).toBe(302);
  const request = new URL(authorization.headers.get("location")!).searchParams.get("request")!;
  return { request, csrf: await inspectConsent(env, request) };
}

async function consentMutation(env: Env, request: string, csrf: string, action: "approve" | "deny", origin = issuer) {
  return app.request(`/api/consent/${encodeURIComponent(request)}/${action}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf_token: csrf }),
  }, env);
}

async function approveConsent(env: Env, request: string, csrf: string): Promise<string> {
  const response = await consentMutation(env, request, csrf, "approve");
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

function tokenRequest(
  code: string,
  verifier?: string,
  overrides: Partial<Record<"client_id" | "redirect_uri" | "grant_type", string>> = {},
): RequestInit {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "local-dev",
    redirect_uri: redirectUri,
    code,
    ...overrides,
  });
  if (verifier !== undefined) body.set("code_verifier", verifier);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  };
}

async function seedAuthorizationCode(env: Env, values: {
  code: string;
  verifier: string;
  clientId?: string;
  redirect?: string;
}): Promise<void> {
  const clientId = values.clientId ?? "local-dev";
  const target = values.redirect ?? redirectUri;
  if (clientId !== "local-dev") {
    await env.DB.prepare("INSERT INTO clients (client_id, name, redirect_uris, providers, created_at) VALUES (?, 'Length test', ?, '[\"github\"]', unixepoch())")
      .bind(clientId, JSON.stringify([target])).run();
  }
  await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_length', unixepoch())").run();
  await env.DB.prepare(`INSERT INTO authorization_codes
    (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at)
    VALUES (?, ?, ?, 'acct_length', 'github:42', ?, unixepoch() + 120)`)
    .bind(await sha256(values.code), clientId, target, await sha256(values.verifier)).run();
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

  it("keeps one CSRF row while repeated consent inspection rotates the token", async () => {
    const env = await testEnv();
    const { request, csrf: first } = await beginConsent(env);
    const second = await inspectConsent(env, request);
    const purpose = `consent:${await sha256(request)}`;
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM csrf_tokens WHERE purpose = ?")
      .bind(purpose).first<{ count: number }>();

    expect(second).not.toBe(first);
    expect(row?.count).toBe(1);
    const stale = await consentMutation(env, request, first, "approve");
    expect(stale.status).toBe(403);
  });

  it.each(["approve", "deny"] as const)("requires origin and rotated CSRF for consent %s with an exact redirect", async (action) => {
    const env = await testEnv();
    const { request, csrf: first } = await beginConsent(env);
    const crossOrigin = await consentMutation(env, request, first, action, "https://evil.example");
    expect(crossOrigin.status).toBe(403);

    const current = await inspectConsent(env, request);
    const invalidCsrf = await consentMutation(env, request, "wrong-token", action);
    expect(invalidCsrf.status).toBe(403);

    const accepted = await consentMutation(env, request, current, action);
    expect(accepted.status).toBe(200);
    const target = new URL((await accepted.json<{ redirect_to: string }>()).redirect_to);
    if (action === "approve") {
      expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(target.searchParams.get("redirect_uri")).toBe(`${issuer}/callback/github`);
      expect(target.searchParams.get("state")).toHaveLength(43);
    } else {
      expect(target.origin + target.pathname).toBe(redirectUri);
      expect(Object.fromEntries(target.searchParams)).toEqual({ error: "access_denied", state: "client-state" });
    }

    const independent = await createCsrfToken(env.DB, `consent:${await sha256(request)}`);
    const replay = await consentMutation(env, request, independent, action);
    expect(replay.status).toBe(404);
  });

  it("checks consent origin before reading the request body", async () => {
    const env = await testEnv();
    const { request } = await beginConsent(env);
    const unreadable = new ReadableStream({
      pull(controller) {
        controller.error(new Error("body must not be read"));
      },
    });
    const response = await app.request(`/api/consent/${request}/approve`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: unreadable,
      duplex: "half",
    } as unknown as RequestInit, env);

    expect(response.status).toBe(403);
  });

  it.each([
    "/api/consent/ticket/approve",
    "/api/consent/ticket/deny",
    "/token",
  ])("rejects an oversized OAuth POST before parsing: %s", async (path) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { origin: issuer, "content-type": "application/x-www-form-urlencoded" },
      body: `value=${"a".repeat(4097)}`,
    }, await testEnv());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("returns invalid_client for an unknown token client", async () => {
    const response = await app.request("/token", tokenRequest("code", "a".repeat(43), { client_id: "unknown" }), await testEnv());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it.each([
    ["client_id", "a".repeat(129), "code", "A".repeat(43), redirectUri, "invalid_client"],
    ["code", "local-dev", "a".repeat(129), "A".repeat(43), redirectUri, "invalid_grant"],
    ["verifier", "local-dev", "code", "A".repeat(129), redirectUri, "invalid_grant"],
    ["redirect_uri", "local-dev", "code", "A".repeat(43), `https://app.example/${"a".repeat(2049)}`, "invalid_grant"],
  ])("rejects an oversized token %s", async (_name, clientId, code, verifier, target, error) => {
    const env = await testEnv();
    await seedAuthorizationCode(env, { code, verifier, clientId, redirect: target });
    const response = await app.request("/token", tokenRequest(code, verifier, {
      client_id: clientId,
      redirect_uri: target,
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error });
  });

  it("consumes callback state once under concurrent redemption", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const upstreamState = await approveConsent(env, request, csrf);
    const fetch = stubGithub();
    const callback = `/callback/github?state=${upstreamState}&code=provider-code`;

    const responses = await Promise.all([
      app.request(callback, undefined, env),
      app.request(callback, undefined, env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    const rejected = responses.find((response) => response.status === 400)!;
    await expect(rejected.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires a valid 128-character verifier and consumes once under concurrent redemption", async () => {
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

    const responses = await Promise.all([
      app.request("/token", tokenRequest(code, verifier), env),
      app.request("/token", tokenRequest(code, verifier), env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const exchanged = responses.find((response) => response.status === 200)!;
    const replay = responses.find((response) => response.status === 400)!;
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    await expect(exchanged.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 600 });
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });
});
