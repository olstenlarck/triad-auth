import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";
import { openClaims, sha256 } from "../src/crypto";
import { preAuthCookieName } from "../src/pre-auth";
import { createCsrfToken } from "../src/security";
import type { Env } from "../src/types";
import { createTestDb, SqliteD1 } from "./d1";

const issuer = "https://auth.example";
const redirectUri = `${issuer}/demo/callback/`;
let signingPrivateJwk: string;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingPrivateJwk = JSON.stringify({ ...(await exportJWK(privateKey)), kid: "test" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function testEnv(canonicalIssuer = issuer, overrides: Partial<Env> = {}): Promise<Env> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ISSUER: canonicalIssuer,
    SIGNING_PRIVATE_JWK: signingPrivateJwk,
    PAIRWISE_SECRET: "p".repeat(32),
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    ...overrides,
  };
}

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    client_id: "triad-demo",
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

async function beginConsent(
  env: Env,
  overrides: Record<string, string> = {},
): Promise<{ request: string; csrf: string }> {
  const authorization = await app.request(authorizeUrl(overrides), undefined, env);
  expect(authorization.status).toBe(302);
  const request = new URL(authorization.headers.get("location")!).searchParams.get("request")!;
  return { request, csrf: await inspectConsent(env, request) };
}

async function consentMutation(
  env: Env,
  request: string,
  csrf: string,
  action: "approve" | "deny",
  origin = issuer,
) {
  return app.request(
    `/api/consent/${encodeURIComponent(request)}/${action}`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf }),
    },
    env,
  );
}

async function approveConsent(
  env: Env,
  request: string,
  csrf: string,
): Promise<{ state: string; binding: string; cookieName: string; setCookie: string }> {
  const response = await consentMutation(env, request, csrf, "approve");
  expect(response.status).toBe(200);
  const body = await response.json<{ redirect_to: string }>();
  const state = new URL(body.redirect_to).searchParams.get("state")!;
  const cookieName = preAuthCookieName(await sha256(state));
  return {
    state,
    cookieName,
    binding: responseCookie(response, cookieName),
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

function stubGithub(id = 42) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "temporary", token_type: "bearer", scope: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id, login: "mutable-name" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stubGithubProfile() {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "temporary" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 42,
          login: "unrequested-handle",
          name: "User",
          avatar_url: "https://example.test/avatar.png",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify([{ email: "user@example.com", primary: true, verified: true }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function responseCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1];
  expect(value).toBeTruthy();
  return `${name}=${value}`;
}

async function issueAuthorizationCode(env: Env, verifier: string): Promise<string> {
  const { request, csrf } = await beginConsent(env, { code_challenge: await sha256(verifier) });
  const { state: upstreamState, binding } = await approveConsent(env, request, csrf);
  stubGithub();
  const callback = await app.request(
    `/callback/github?state=${encodeURIComponent(upstreamState)}&code=provider-code`,
    {
      headers: { cookie: binding },
    },
    env,
  );
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
    client_id: "triad-demo",
    redirect_uri: redirectUri,
    code,
    ...overrides,
  });
  if (verifier !== undefined) {
    body.set("code_verifier", verifier);
  }
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  };
}

async function seedAuthorizationCode(
  env: Env,
  values: {
    code: string;
    verifier: string;
    clientId?: string;
    redirect?: string;
  },
): Promise<void> {
  const clientId = values.clientId ?? "triad-demo";
  const target = values.redirect ?? redirectUri;
  if (clientId !== "triad-demo") {
    await env.DB.prepare(
      "INSERT INTO clients (client_id, name, redirect_uris, providers, created_at) VALUES (?, 'Length test', ?, '[\"github\"]', unixepoch())",
    )
      .bind(clientId, JSON.stringify([target]))
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO accounts (id, created_at) VALUES ('acct_length', unixepoch())",
  ).run();
  await env.DB.prepare(
    `INSERT INTO authorization_codes
    (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at)
    VALUES (?, ?, ?, 'acct_length',
      'pid_github_d2ee98e4ac33ccc6387b157c7ed07f5bd2ee98e4ac33ccc6387b157c7ed07f5b',
      ?, unixepoch() + 120)`,
  )
    .bind(await sha256(values.code), clientId, target, await sha256(values.verifier))
    .run();
}

describe("authorization-code routes", () => {
  it("returns only providers with complete configured credential pairs", async () => {
    const env = await testEnv(issuer, {
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      TWITTER_CLIENT_ID: "twitter-client-without-secret",
    });

    const response = await app.request("/api/providers", undefined, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: [
        { id: "google", scopes: ["email", "name", "avatar"] },
        { id: "github", scopes: ["email", "handle", "name", "avatar"] },
      ],
    });
  });

  it("applies fresh migrations sequentially with multi-provider columns and allowlists", async () => {
    const env = await testEnv();
    const tables = ["oauth_transactions", "authorization_codes", "device_grants"];
    const columns = new Map<string, string[]>();
    for (const table of tables) {
      const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      columns.set(
        table,
        result.results.map(({ name }) => name),
      );
    }

    expect(columns.get("oauth_transactions")).toContain("scopes");
    expect(columns.get("authorization_codes")).toEqual(
      expect.arrayContaining(["provider", "scopes", "claims_ciphertext"]),
    );
    expect(columns.get("device_grants")).toEqual(
      expect.arrayContaining(["provider", "scopes", "claims_ciphertext"]),
    );
    const clients = await env.DB.prepare(
      "SELECT client_id, providers FROM clients ORDER BY client_id",
    ).all();
    expect(clients.results).toEqual([
      { client_id: "triad-account", providers: '["google","github","twitter"]' },
      { client_id: "triad-demo", providers: '["google","github","twitter"]' },
    ]);
  });

  it("upgrades a populated 0001 database without losing durable identity or consent data", async () => {
    const sqlite = await SqliteD1.create(["0001_init.sql"]);
    const db = sqlite as unknown as D1Database;
    try {
      await db.batch([
        db.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_durable', 1)"),
        db.prepare(`INSERT INTO identities (provider, provider_user_id, account_id, created_at)
          VALUES ('github', '42', 'acct_durable', 1)`),
        db.prepare(`INSERT INTO consents (account_id, client_id, scopes, updated_at)
          VALUES ('acct_durable', 'triad-demo', '["openid"]', 1)`),
        db.prepare(`INSERT INTO consent_requests
          (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
          VALUES ('request', 'triad-demo', 'https://app.example/callback', 'state', 'github', 'challenge',
            '["openid"]', 9999999999, 1)`),
        db.prepare(`INSERT INTO oauth_transactions
          (state_hash, kind, client_id, provider, browser_binding_hash, expires_at, created_at)
          VALUES ('state', 'session', 'triad-account', 'github', 'binding', 9999999999, 1)`),
        db.prepare(`INSERT INTO authorization_codes
          (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at)
          VALUES ('code', 'triad-demo', 'https://app.example/callback', 'acct_durable', 'raw', 'challenge',
            9999999999)`),
        db.prepare(`INSERT INTO device_grants
          (device_code_hash, user_code, client_id, status, expires_at, interval_seconds, created_at)
          VALUES ('device', 'ABCD2345', 'triad-demo', 'pending', 9999999999, 5, 1)`),
      ]);

      sqlite.applyMigration("0002_multi_provider.sql");

      await expect(db.prepare("SELECT id, created_at FROM accounts").all()).resolves.toMatchObject({
        results: [{ id: "acct_durable", created_at: 1 }],
      });
      await expect(
        db.prepare("SELECT provider, provider_user_id, account_id FROM identities").all(),
      ).resolves.toMatchObject({
        results: [{ provider: "github", provider_user_id: "42", account_id: "acct_durable" }],
      });
      await expect(
        db.prepare("SELECT account_id, client_id, scopes FROM consents").all(),
      ).resolves.toMatchObject({
        results: [{ account_id: "acct_durable", client_id: "triad-demo", scopes: '["openid"]' }],
      });
      for (const table of [
        "consent_requests",
        "oauth_transactions",
        "authorization_codes",
        "device_grants",
      ]) {
        expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
      }
      const codeColumns = await db
        .prepare("PRAGMA table_info(authorization_codes)")
        .all<{ name: string }>();
      expect(codeColumns.results.map(({ name }) => name)).toContain("provider");
    } finally {
      sqlite.close();
    }
  });

  it("resets prototype identity state without deleting clients or rate limits", async () => {
    const sqlite = await SqliteD1.create(["0001_init.sql", "0002_multi_provider.sql"]);
    const db = sqlite as unknown as D1Database;

    try {
      await db.batch([
        db.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_legacy', 1)"),
        db.prepare(`INSERT INTO identities (provider, provider_user_id, account_id, created_at)
          VALUES ('github', '42', 'acct_legacy', 1)`),
        db.prepare(`INSERT INTO consents (account_id, client_id, scopes, updated_at)
          VALUES ('acct_legacy', 'triad-demo', '["openid"]', 1)`),
        db.prepare(`INSERT INTO browser_sessions (session_hash, account_id, expires_at, created_at)
          VALUES ('session', 'acct_legacy', 9999999999, 1)`),
        db.prepare(`INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at)
          VALUES ('csrf', 'account:session', 9999999999, 1)`),
        db.prepare(`INSERT INTO rate_limits (bucket, key_hash, window_start, expires_at, count)
          VALUES ('test', 'key', 1, 9999999999, 1)`),
      ]);

      sqlite.applyMigration("0003_reset_subject_formats.sql");

      for (const table of ["accounts", "identities", "consents", "browser_sessions", "csrf_tokens"]) {
        expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
      }
      expect(await db.prepare("SELECT COUNT(*) AS count FROM clients").first("count")).toBe(2);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM rate_limits").first("count")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["google", { GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" }],
    ["github", {}],
    ["twitter", { TWITTER_CLIENT_ID: "twitter-client", TWITTER_CLIENT_SECRET: "twitter-secret" }],
  ] as const)(
    "sets and clears the %s callback-bound pre-auth cookie exactly",
    async (provider, overrides) => {
      const env = await testEnv(issuer, overrides);
      const { request, csrf } = await beginConsent(env, { provider });
      const approved = await approveConsent(env, request, csrf);
      expect(approved.setCookie).toContain(`Path=/callback/${provider}`);

      const denied = await app.request(
        `/callback/${provider}?state=${approved.state}&error=access_denied`,
        {
          headers: { cookie: approved.binding },
        },
        env,
      );

      expect(denied.status).toBe(302);
      const cleared = denied.headers.get("set-cookie") ?? "";
      expect(cleared).toContain(`${approved.cookieName}=;`);
      expect(cleared).toContain(`Path=/callback/${provider}`);
      expect(cleared).toMatch(/Max-Age=0/i);
    },
  );

  it("redirects a mandatory profile-value failure as access_denied without issuing a code", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env, { scope: "openid name" });
    const approved = await approveConsent(env, request, csrf);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 42, name: null }), { status: 200 }),
        ),
    );

    const callback = await app.request(
      `/callback/github?state=${approved.state}&code=provider-code`,
      {
        headers: { cookie: approved.binding },
      },
      env,
    );

    expect(callback.status).toBe(302);
    const target = new URL(callback.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(redirectUri);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      error: "access_denied",
      state: "client-state",
    });
    expect(logged).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_codes").first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count"),
    ).toBe(0);
  });

  it("rejects unavailable providers and provider-incompatible scopes before consent creation", async () => {
    const env = await testEnv();

    const unavailable = await app.request(authorizeUrl({ provider: "google" }), undefined, env);
    const incompatible = await app.request(
      authorizeUrl({ provider: "twitter", scope: "openid email" }),
      undefined,
      {
        ...env,
        TWITTER_CLIENT_ID: "twitter-client",
        TWITTER_CLIENT_SECRET: "twitter-secret",
      },
    );

    await expect(unavailable.json()).resolves.toMatchObject({ error: "invalid_request" });
    await expect(incompatible.json()).resolves.toMatchObject({ error: "invalid_scope" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM consent_requests").first("count"),
    ).toBe(0);
  });

  it("persists the selected Google provider, nonce, and canonical scopes through consent", async () => {
    const env = await testEnv(issuer, {
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const { request } = await beginConsent(env, {
      provider: "google",
      scope: "name openid email email",
    });
    const consent = await app.request(`/api/consent/${request}`, undefined, env);
    const consentBody = await consent.json<{
      csrf_token: string;
      provider: string;
      scopes: string[];
    }>();
    expect(consentBody).toMatchObject({
      provider: "google",
      scopes: ["openid", "email", "name"],
    });

    const approved = await approveConsent(env, request, consentBody.csrf_token);
    const row = await env.DB.prepare(
      `SELECT provider, provider_nonce, provider_verifier, scopes
      FROM oauth_transactions WHERE state_hash = ?`,
    )
      .bind(await sha256(approved.state))
      .first();
    expect(row).toEqual({
      provider: "google",
      provider_nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      provider_verifier: null,
      scopes: '["openid","email","name"]',
    });
  });

  it("rejects a callback whose provider does not match the consumed transaction", async () => {
    const env = await testEnv(issuer, {
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const { request, csrf } = await beginConsent(env, { provider: "google" });
    const { state, binding } = await approveConsent(env, request, csrf);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: binding },
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("carries encrypted minimal claims and canonical scopes through one-time code exchange", async () => {
    const env = await testEnv();
    const verifier = "V".repeat(43);
    const { request, csrf } = await beginConsent(env, {
      code_challenge: await sha256(verifier),
      scope: "name openid email email",
    });
    const { state, binding } = await approveConsent(env, request, csrf);
    stubGithubProfile();
    const callback = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: binding },
      },
      env,
    );
    const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const codeHash = await sha256(code);
    const stored = await env.DB.prepare(
      `SELECT provider, scopes, claims_ciphertext FROM authorization_codes
      WHERE code_hash = ?`,
    )
      .bind(codeHash)
      .first<{
        provider: string;
        scopes: string;
        claims_ciphertext: string;
      }>();

    expect(stored?.provider).toBe("github");
    expect(stored?.scopes).toBe('["openid","email","name"]');
    expect(stored?.claims_ciphertext).toMatch(/^v1\./);
    expect(stored?.claims_ciphertext).not.toContain("user@example.com");
    await expect(
      openClaims(env.PAIRWISE_SECRET, codeHash, stored!.claims_ciphertext),
    ).resolves.toEqual({
      email: "user@example.com",
      email_verified: true,
      name: "User",
    });
    await expect(
      openClaims(env.PAIRWISE_SECRET, await sha256("other-code"), stored!.claims_ciphertext),
    ).rejects.toThrow();

    const exchanged = await app.request("/token", tokenRequest(code, verifier), env);
    const body = await exchanged.json<{ id_token: string; scope: string }>();
    expect(body.scope).toBe("openid email name");
    expect(decodeJwt(body.id_token)).toMatchObject({ email: "user@example.com", name: "User" });
    expect(decodeJwt(body.id_token)).not.toHaveProperty("preferred_username");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_codes WHERE code_hash = ?")
        .bind(codeHash)
        .first("count"),
    ).toBe(0);
  });

  it("persists the selected Twitter provider on the authorization code", async () => {
    const env = await testEnv(issuer, {
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });
    const { request, csrf } = await beginConsent(env, { provider: "twitter" });
    const approved = await approveConsent(env, request, csrf);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { id: "2244994945" } }), { status: 200 }),
        ),
    );

    const callback = await app.request(
      `/callback/twitter?state=${approved.state}&code=provider-code`,
      {
        headers: { cookie: approved.binding },
      },
      env,
    );

    expect(callback.status).toBe(302);
    expect(await env.DB.prepare("SELECT provider FROM authorization_codes").first("provider")).toBe(
      "twitter",
    );
  });

  it("revalidates the authorization-code provider allowlist before atomic consumption", async () => {
    const env = await testEnv();
    const code = "provider-revalidation-code";
    const verifier = "V".repeat(43);
    await seedAuthorizationCode(env, { code, verifier });
    await env.DB.prepare(
      "UPDATE clients SET providers = '[\"google\"]' WHERE client_id = 'triad-demo'",
    ).run();

    const response = await app.request("/token", tokenRequest(code, verifier), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(
      await env.DB.prepare("SELECT consumed_at FROM authorization_codes").first("consumed_at"),
    ).toBeNull();
  });

  it("deletes an authorization code before decrypting its claim payload", async () => {
    const env = await testEnv();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = "claim-code";
    const verifier = "V".repeat(43);
    await seedAuthorizationCode(env, { code, verifier });
    await env.DB.prepare(
      `UPDATE authorization_codes
      SET scopes = '["openid"]', claims_ciphertext = 'v1.invalid' WHERE code_hash = ?`,
    )
      .bind(await sha256(code))
      .run();

    const response = await app.request("/token", tokenRequest(code, verifier), env);

    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith("OAuth route failed");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_codes WHERE code_hash = ?")
        .bind(await sha256(code))
        .first("count"),
    ).toBe(0);
    const replay = await app.request("/token", tokenRequest(code, verifier), env);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it.each([
    ["local", "http://localhost:8787"],
    ["production", "https://auth.example"],
  ])(
    "derives the exact %s demo callback from the canonical issuer",
    async (_environment, canonicalIssuer) => {
      const env = await testEnv(canonicalIssuer);
      const callback = `${canonicalIssuer}/demo/callback/`;

      const accepted = await app.request(authorizeUrl({ redirect_uri: callback }), undefined, env);
      expect(accepted.status).toBe(302);

      for (const rejected of [
        `${canonicalIssuer}/demo/callback`,
        "https://other.example/demo/callback/",
      ]) {
        const response = await app.request(
          authorizeUrl({ redirect_uri: rejected }),
          undefined,
          env,
        );
        expect(response.status).toBe(400);
        expect(response.headers.has("location")).toBe(false);
      }
    },
  );

  it("advertises canonical scopes, claims, and only pairwise subject identifiers", async () => {
    const response = await app.request(
      "/.well-known/openid-configuration",
      undefined,
      await testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subject_types_supported: ["pairwise"],
      scopes_supported: ["openid", "email", "handle", "name", "avatar"],
      claims_supported: [
        "sub",
        "pairwise_sub",
        "account_sub",
        "provider_sub",
        "email",
        "email_verified",
        "preferred_username",
        "name",
        "picture",
      ],
    });
  });

  it("binds an approved consent callback to the browser that started GitHub", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const approved = await consentMutation(env, request, csrf, "approve");
    expect(approved.status).toBe(200);
    const state = new URL(
      (await approved.json<{ redirect_to: string }>()).redirect_to,
    ).searchParams.get("state")!;
    const cookieName = preAuthCookieName(await sha256(state));
    const binding = responseCookie(approved, cookieName);
    const fetch = stubGithub();

    const wrongBrowser = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: `${cookieName}=wrong-browser` },
      },
      env,
    );
    expect(wrongBrowser.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions WHERE state_hash = ?")
        .bind(await sha256(state))
        .first("count"),
    ).toBe(1);

    const completed = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: binding },
      },
      env,
    );
    expect(completed.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(completed.headers.get("set-cookie")).toMatch(
      new RegExp(`${cookieName}=;.*Max-Age=0`, "i"),
    );
  });

  it("mounts security headers on the root Hono application", async () => {
    const response = await app.request(
      authorizeUrl({ client_id: "unknown" }),
      undefined,
      await testEnv(),
    );

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
    const response = await app.request(
      authorizeUrl({ code_challenge: challenge }),
      undefined,
      await testEnv(),
    );
    expect(response.status).toBe(status);
  });

  it("keeps one CSRF row while repeated consent inspection rotates the token", async () => {
    const env = await testEnv();
    const { request, csrf: first } = await beginConsent(env);
    const second = await inspectConsent(env, request);
    const purpose = `consent:${await sha256(request)}`;
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM csrf_tokens WHERE purpose = ?")
      .bind(purpose)
      .first<{ count: number }>();

    expect(second).not.toBe(first);
    expect(row?.count).toBe(1);
    const stale = await consentMutation(env, request, first, "approve");
    expect(stale.status).toBe(403);
  });

  it.each(["approve", "deny"] as const)(
    "requires origin and rotated CSRF for consent %s with an exact redirect",
    async (action) => {
      const env = await testEnv();
      const { request, csrf: first } = await beginConsent(env);
      const crossOrigin = await consentMutation(
        env,
        request,
        first,
        action,
        "https://evil.example",
      );
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
        expect(Object.fromEntries(target.searchParams)).toEqual({
          error: "access_denied",
          state: "client-state",
        });
      }

      const independent = await createCsrfToken(env.DB, `consent:${await sha256(request)}`);
      const replay = await consentMutation(env, request, independent, action);
      expect(replay.status).toBe(404);
    },
  );

  it("checks consent origin before reading the request body", async () => {
    const env = await testEnv();
    const { request } = await beginConsent(env);
    const unreadable = new ReadableStream({
      pull(controller) {
        controller.error(new Error("body must not be read"));
      },
    });
    const response = await app.request(
      `/api/consent/${request}/approve`,
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: unreadable,
        duplex: "half",
      } as unknown as RequestInit,
      env,
    );

    expect(response.status).toBe(403);
  });

  it.each(["/api/consent/ticket/approve", "/api/consent/ticket/deny", "/token"])(
    "rejects an oversized OAuth POST before parsing: %s",
    async (path) => {
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: { origin: issuer, "content-type": "application/x-www-form-urlencoded" },
          body: `value=${"a".repeat(4097)}`,
        },
        await testEnv(),
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    },
  );

  it("returns invalid_client for an unknown token client", async () => {
    const response = await app.request(
      "/token",
      tokenRequest("code", "a".repeat(43), { client_id: "unknown" }),
      await testEnv(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it.each([
    ["client_id", "a".repeat(129), "code", "A".repeat(43), redirectUri, "invalid_client"],
    ["code", "triad-demo", "a".repeat(129), "A".repeat(43), redirectUri, "invalid_grant"],
    ["verifier", "triad-demo", "code", "A".repeat(129), redirectUri, "invalid_grant"],
    [
      "redirect_uri",
      "triad-demo",
      "code",
      "A".repeat(43),
      `https://app.example/${"a".repeat(2049)}`,
      "invalid_grant",
    ],
  ])("rejects an oversized token %s", async (_name, clientId, code, verifier, target, error) => {
    const env = await testEnv();
    await seedAuthorizationCode(env, { code, verifier, clientId, redirect: target });
    const response = await app.request(
      "/token",
      tokenRequest(code, verifier, {
        client_id: clientId,
        redirect_uri: target,
      }),
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error });
  });

  it("consumes callback state once under concurrent redemption", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const { state: upstreamState, binding } = await approveConsent(env, request, csrf);
    const fetch = stubGithub();
    const callback = `/callback/github?state=${upstreamState}&code=provider-code`;

    const responses = await Promise.all([
      app.request(callback, { headers: { cookie: binding } }, env),
      app.request(callback, { headers: { cookie: binding } }, env),
    ]);
    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([302, 400]);
    const rejected = responses.find((response) => response.status === 400)!;
    await expect(rejected.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("consumes a GitHub denial without a code and redirects an authorization request exactly", async () => {
    const env = await testEnv();
    const { request, csrf } = await beginConsent(env);
    const { state: upstreamState, binding, cookieName } = await approveConsent(env, request, csrf);
    const second = await beginConsent(env, { state: "second-client-state" });
    const other = await approveConsent(env, second.request, second.csrf);

    const denied = await app.request(
      `/callback/github?state=${upstreamState}&error=access_denied`,
      {
        headers: { cookie: `${binding}; ${other.binding}` },
      },
      env,
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const target = new URL(denied.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(redirectUri);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      error: "access_denied",
      state: "client-state",
    });
    expect(denied.headers.get("set-cookie")).toContain(`${cookieName}=;`);
    expect(denied.headers.get("set-cookie")).not.toContain(`${other.cookieName}=;`);

    const replay = await app.request(
      `/callback/github?state=${upstreamState}&error=access_denied`,
      { headers: { cookie: binding } },
      env,
    );
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
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
    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([200, 400]);
    const exchanged = responses.find((response) => response.status === 200)!;
    const replay = responses.find((response) => response.status === 400)!;
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    await expect(exchanged.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: 300,
    });
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_codes").first("count"),
    ).toBe(0);
  });

  it("returns a five-minute lifetime for an approved device token", async () => {
    const env = await testEnv();
    const deviceCode = "d".repeat(43);
    await env.DB.prepare(
      "INSERT INTO accounts (id, created_at) VALUES ('acct_device', unixepoch())",
    ).run();
    await env.DB.prepare(
      `INSERT INTO device_grants
      (device_code_hash, user_code, client_id, status, account_id, provider_sub, expires_at,
        interval_seconds, created_at)
      VALUES (?, 'ABCD2345', 'triad-demo', 'approved', 'acct_device',
        'pid_github_d2ee98e4ac33ccc6387b157c7ed07f5bd2ee98e4ac33ccc6387b157c7ed07f5b',
        unixepoch() + 600, 5, unixepoch())`,
    )
      .bind(await sha256(deviceCode))
      .run();

    const response = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "triad-demo",
          device_code: deviceCode,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 300 });
  });
});
