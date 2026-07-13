import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";
import { providerSubject, sha256 } from "../src/crypto";
import { deleteAccount } from "../src/db";
import { preAuthCookieName } from "../src/pre-auth";
import type { Env } from "../src/types";
import { createTestDb } from "./d1";

declare const process: {
  getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
};

const issuer = "https://auth.example";
const cleanups: Array<() => void> = [];
const secretBindings = {
  IDENTIFIER_SECRET: "i".repeat(32),
  CLAIMS_ENCRYPTION_KEYRING: JSON.stringify({
    active: "current",
    keys: { current: "c".repeat(32) },
  }),
  RATE_LIMIT_SECRET: "r".repeat(32),
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ISSUER: issuer,
    SIGNING_KEYRING: "unused",
    ...secretBindings,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    ...overrides,
  };
}

async function seedSession(env: Env, token = "existing-session"): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO accounts (id, created_at) VALUES ('acct_account', unixepoch())",
  ).run();
  await env.DB.prepare(
    `INSERT INTO identities
    (provider, provider_user_id, account_id, created_at)
    VALUES ('github', '42', 'acct_account', unixepoch())`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO browser_sessions
    (session_hash, account_id, expires_at, created_at)
    VALUES (?, 'acct_account', unixepoch() + 2592000, unixepoch())`,
  )
    .bind(await sha256(token))
    .run();
  return token;
}

async function inspectAccount(
  env: Env,
  token: string,
): Promise<{ csrf_token: string; clients: unknown[] }> {
  const response = await app.request(
    "/api/me",
    {
      headers: { cookie: `triad_session=${token}` },
    },
    env,
  );
  expect(response.status).toBe(200);
  return response.json<{ csrf_token: string; clients: unknown[] }>();
}

function accountMutation(path: string, token: string, csrf: string, origin = issuer): RequestInit {
  return {
    method: path === "/session/logout" ? "POST" : "DELETE",
    headers: {
      origin,
      cookie: `triad_session=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf_token: csrf }),
  };
}

function stubGithub(): void {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "temporary" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
}

function responseCookie(response: Response, name: string): { pair: string; header: string } {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1];
  expect(value).toBeTruthy();
  return { pair: `${name}=${value}`, header };
}

describe("account sessions", () => {
  it("deletes only account-bound state while preserving global records", async () => {
    const env = await testEnv();
    const targetSessions = ["target-session-a", "target-session-b"];

    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_target', unixepoch())"),
      env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_other', unixepoch())"),
      env.DB.prepare(
        `INSERT INTO identities (provider, provider_user_id, account_id, created_at) VALUES
        ('github', 'target-github', 'acct_target', unixepoch()),
        ('google', 'target-google', 'acct_target', unixepoch()),
        ('github', 'other-github', 'acct_other', unixepoch())`,
      ),
      env.DB.prepare(
        `INSERT INTO browser_sessions (session_hash, account_id, expires_at, created_at) VALUES
        (?, 'acct_target', unixepoch() + 300, unixepoch()),
        (?, 'acct_target', unixepoch() + 300, unixepoch()),
        ('other-session', 'acct_other', unixepoch() + 300, unixepoch())`,
      ).bind(...targetSessions),
      env.DB.prepare(
        `INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at) VALUES
        ('target-csrf-a', ?, unixepoch() + 300, unixepoch()),
        ('target-csrf-b', ?, unixepoch() + 300, unixepoch()),
        ('other-csrf', 'account:other-session', unixepoch() + 300, unixepoch())`,
      ).bind(...targetSessions.map((session) => `account:${session}`)),
      env.DB.prepare(
        `INSERT INTO authorization_codes
        (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at)
        VALUES
        ('target-code', 'triad-demo', 'https://client.example/callback', 'acct_target', 'pid_target', 'challenge', unixepoch() + 300),
        ('other-code', 'triad-demo', 'https://client.example/callback', 'acct_other', 'pid_other', 'challenge', unixepoch() + 300)`,
      ),
      env.DB.prepare(
        `INSERT INTO device_grants
        (device_code_hash, user_code, client_id, status, account_id, provider_sub, expires_at, interval_seconds, created_at)
        VALUES
        ('target-device', 'TARGET01', 'triad-demo', 'approved', 'acct_target', 'pid_target', unixepoch() + 300, 5, unixepoch()),
        ('other-device', 'OTHER001', 'triad-demo', 'approved', 'acct_other', 'pid_other', unixepoch() + 300, 5, unixepoch())`,
      ),
      env.DB.prepare(
        `INSERT INTO consents (account_id, client_id, scopes, updated_at) VALUES
        ('acct_target', 'triad-demo', '["openid"]', unixepoch()),
        ('acct_other', 'triad-demo', '["openid"]', unixepoch())`,
      ),
      env.DB.prepare(
        `INSERT INTO rate_limits (bucket, key_hash, window_start, expires_at, count)
        VALUES ('account', 'global-key', unixepoch(), unixepoch() + 300, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO device_client_verifications
        (client_id, name, verified_at, expires_at)
        VALUES ('https://device.example', 'Verified device', unixepoch(), unixepoch() + 3600)`,
      ),
    ]);

    await expect(deleteAccount(env.DB, "acct_target")).resolves.toBe(true);

    for (const table of [
      "accounts",
      "identities",
      "browser_sessions",
      "authorization_codes",
      "device_grants",
      "consents",
    ]) {
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
        table,
      ).toBe(1);
    }
    expect(await env.DB.prepare("SELECT purpose FROM csrf_tokens").first("purpose")).toBe(
      "account:other-session",
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM clients").first("count")).toBe(2);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM device_client_verifications").first(
        "count",
      ),
    ).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits").first("count")).toBe(
      1,
    );
    await expect(deleteAccount(env.DB, "acct_missing")).resolves.toBe(false);
  });

  it("starts configured Google, GitHub, and Twitter sessions with provider state", async () => {
    const env = await testEnv({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });

    const responses = await Promise.all(
      ["google", "github", "twitter"].map((provider) =>
        app.request(`/session/start/${provider}`, undefined, env),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([302, 302, 302]);
    expect(new URL(responses[0].headers.get("location")!).hostname).toBe("accounts.google.com");
    expect(new URL(responses[1].headers.get("location")!).hostname).toBe("github.com");
    expect(new URL(responses[2].headers.get("location")!).hostname).toBe("x.com");
    for (const [index, provider] of ["google", "github", "twitter"].entries()) {
      expect(responses[index].headers.get("set-cookie")).toContain(`Path=/callback/${provider}`);
    }
    const rows = await env.DB.prepare(
      `SELECT provider, provider_verifier, provider_nonce, scopes
      FROM oauth_transactions ORDER BY provider`,
    ).all();
    expect(rows.results).toEqual([
      { provider: "github", provider_verifier: null, provider_nonce: null, scopes: '["openid"]' },
      {
        provider: "google",
        provider_verifier: null,
        provider_nonce: expect.any(String),
        scopes: '["openid"]',
      },
      {
        provider: "twitter",
        provider_verifier: expect.any(String),
        provider_nonce: null,
        scopes: '["openid"]',
      },
    ]);
  });

  it("recovers a session mandatory-profile failure without creating a session", async () => {
    const env = await testEnv();
    const state = "mandatory-session-state";
    const stateHash = await sha256(state);
    const binding = "mandatory-session-binding";
    await env.DB.prepare(
      `INSERT INTO oauth_transactions
      (state_hash, kind, client_id, provider, scopes, browser_binding_hash, expires_at, created_at)
      VALUES (?, 'session', 'triad-account', 'github', '["openid","name"]', ?, unixepoch() + 600, unixepoch())`,
    )
      .bind(stateHash, await sha256(binding))
      .run();
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

    const response = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: `${preAuthCookieName(stateHash)}=${binding}` },
      },
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${issuer}/me/?error=access_denied`);
    expect(response.headers.get("set-cookie")).toContain("Path=/callback/github");
    expect(logged).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"),
    ).toBe(0);
  });

  it("rejects an unavailable session provider before creating state", async () => {
    const env = await testEnv();

    const response = await app.request("/session/start/google", undefined, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count"),
    ).toBe(0);
  });

  it("returns opaque provider subjects instead of raw upstream identity IDs", async () => {
    const env = await testEnv();
    const token = await seedSession(env);

    const response = await app.request(
      "/api/me",
      {
        headers: { cookie: `triad_session=${token}` },
      },
      env,
    );
    const body = await response.json<{ identities: string[] }>();

    expect(body.identities).toEqual([await providerSubject(env.IDENTIFIER_SECRET, "github", "42")]);
    expect(JSON.stringify(body)).not.toContain("github:42");
  });

  it("binds session login to the initiating browser and prevents session swap", async () => {
    const env = await testEnv();
    const victimSession = await seedSession(env, "victim-session");
    const started = await app.request(
      "/session/start/github",
      {
        headers: { "cf-connecting-ip": "203.0.113.8" },
      },
      env,
    );
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const stateHash = await sha256(state);
    const cookieName = preAuthCookieName(stateHash);
    const binding = responseCookie(started, cookieName);
    expect(binding.header).toContain("Max-Age=600");
    expect(binding.header).toContain("Path=/callback/github");
    expect(binding.header).toContain("HttpOnly");
    expect(binding.header).toContain("Secure");
    expect(binding.header).toContain("SameSite=Lax");
    const transaction = await env.DB.prepare(
      "SELECT browser_binding_hash FROM oauth_transactions WHERE state_hash = ?",
    )
      .bind(stateHash)
      .first<{ browser_binding_hash: string }>();
    expect(transaction?.browser_binding_hash).toBe(await sha256(binding.pair.split("=")[1]));
    expect(transaction?.browser_binding_hash).not.toContain(binding.pair.split("=")[1]);

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "temporary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 99 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const swapped = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: {
          cookie: `triad_session=${victimSession}; ${cookieName}=wrong-browser`,
          "cf-connecting-ip": "203.0.113.9",
        },
      },
      env,
    );
    expect(swapped.status).toBe(400);
    await expect(swapped.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions WHERE state_hash = ?")
        .bind(stateHash)
        .first("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT account_id FROM browser_sessions WHERE session_hash = ?")
        .bind(await sha256(victimSession))
        .first("account_id"),
    ).toBe("acct_account");

    const completed = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: { cookie: binding.pair, "cf-connecting-ip": "203.0.113.8" },
      },
      env,
    );
    expect(completed.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(completed.headers.get("set-cookie")).toMatch(
      new RegExp(`${cookieName}=;.*Max-Age=0`, "i"),
    );
  });

  it("completes two concurrent session starts with independent pre-auth cookies", async () => {
    const env = await testEnv();
    const starts = await Promise.all([
      app.request("/session/start/github", undefined, env),
      app.request("/session/start/github", undefined, env),
    ]);
    const flows = await Promise.all(
      starts.map(async (response) => {
        const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
        const cookieName = preAuthCookieName(await sha256(state));
        return { state, cookieName, cookie: responseCookie(response, cookieName).pair };
      }),
    );
    expect(flows[0].cookieName).not.toBe(flows[1].cookieName);
    const fetch = vi.fn();
    for (const id of [41, 42]) {
      fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: `temporary-${id}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
    }
    vi.stubGlobal("fetch", fetch);
    const jar = flows.map(({ cookie }) => cookie).join("; ");

    const first = await app.request(
      `/callback/github?state=${flows[0].state}&code=first`,
      {
        headers: { cookie: jar },
      },
      env,
    );
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toContain(`${flows[0].cookieName}=;`);
    expect(first.headers.get("set-cookie")).not.toContain(`${flows[1].cookieName}=;`);

    const second = await app.request(
      `/callback/github?state=${flows[1].state}&code=second`,
      {
        headers: { cookie: flows[1].cookie },
      },
      env,
    );
    expect(second.status).toBe(302);
    expect(second.headers.get("set-cookie")).toContain(`${flows[1].cookieName}=;`);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("logs out only through a same-origin CSRF-protected POST", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    const get = await app.request("/session/logout", undefined, env);
    expect(get.status).toBe(404);

    const unreadable = new ReadableStream({
      pull(controller) {
        controller.error(new Error("body must not be read"));
      },
    });
    const crossOrigin = await app.request(
      "/session/logout",
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: `triad_session=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: unreadable,
        duplex: "half",
      } as unknown as RequestInit,
      env,
    );
    expect(crossOrigin.status).toBe(403);

    const missingCsrf = await app.request(
      "/session/logout",
      accountMutation("/session/logout", token, "wrong-token"),
      env,
    );
    expect(missingCsrf.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"),
    ).toBe(1);
  });

  it("returns a session-bound CSRF token and revokes consent once", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    await env.DB.prepare(
      `INSERT INTO consents
      (account_id, client_id, scopes, updated_at)
      VALUES ('acct_account', 'triad-demo', '["openid"]', unixepoch())`,
    ).run();
    const account = await inspectAccount(env, token);
    expect(account.csrf_token).toHaveLength(43);
    expect(account.clients).toHaveLength(1);

    const crossOrigin = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation(
        "/api/me/clients/triad-demo",
        token,
        account.csrf_token,
        "https://evil.example",
      ),
      env,
    );
    expect(crossOrigin.status).toBe(403);

    const revoked = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, account.csrf_token),
      env,
    );
    expect(revoked.status).toBe(200);
    const next = await revoked.json<{ csrf_token: string }>();
    expect(next.csrf_token).toHaveLength(43);
    expect(next.csrf_token).not.toBe(account.csrf_token);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM consents").first("count")).toBe(0);

    const replay = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, account.csrf_token),
      env,
    );
    expect(replay.status).toBe(403);
  });

  it("reissues account CSRF after another tab rotates it so a retry succeeds", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    await env.DB.prepare(
      `INSERT INTO consents
      (account_id, client_id, scopes, updated_at)
      VALUES ('acct_account', 'triad-demo', '["openid"]', unixepoch())`,
    ).run();
    const stale = await inspectAccount(env, token);
    const otherTab = await inspectAccount(env, token);
    expect(otherTab.csrf_token).not.toBe(stale.csrf_token);

    const rejected = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, stale.csrf_token),
      env,
    );
    expect(rejected.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM consents").first("count")).toBe(1);

    const recovered = await inspectAccount(env, token);
    const retried = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, recovered.csrf_token),
      env,
    );
    expect(retried.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM consents").first("count")).toBe(0);
  });

  it("clears the hashed D1 session and browser cookie on logout", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    const { csrf_token: csrf } = await inspectAccount(env, token);

    const response = await app.request(
      "/session/logout",
      accountMutation("/session/logout", token, csrf),
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/triad_session=;.*Max-Age=0/i);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"),
    ).toBe(0);
  });

  it("rejects cross-origin and unauthenticated account deletion", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    const { csrf_token: csrf } = await inspectAccount(env, token);

    const crossOrigin = await app.request(
      "/api/me",
      accountMutation("/api/me", token, csrf, "https://evil.example"),
      env,
    );
    expect(crossOrigin.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(1);

    const missingSession = await app.request(
      "/api/me",
      accountMutation("/api/me", "missing-session", csrf),
      env,
    );
    expect(missingSession.status).toBe(401);
    await expect(missingSession.json()).resolves.toMatchObject({ error: "login_required" });
  });

  it("rejects invalid and replayed CSRF tokens for account deletion", async () => {
    const env = await testEnv();
    const token = await seedSession(env);

    const invalid = await app.request(
      "/api/me",
      accountMutation("/api/me", token, "wrong-token"),
      env,
    );
    expect(invalid.status).toBe(403);

    await env.DB.prepare(
      `INSERT INTO consents
      (account_id, client_id, scopes, updated_at)
      VALUES ('acct_account', 'triad-demo', '["openid"]', unixepoch())`,
    ).run();
    const { csrf_token: csrf } = await inspectAccount(env, token);
    const consumed = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, csrf),
      env,
    );
    expect(consumed.status).toBe(200);

    const replay = await app.request("/api/me", accountMutation("/api/me", token, csrf), env);
    expect(replay.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(1);
  });

  it("deletes the account, invalidates every session, and clears the cookie once", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    await env.DB.prepare(
      `INSERT INTO browser_sessions
      (session_hash, account_id, expires_at, created_at)
      VALUES (?, 'acct_account', unixepoch() + 2592000, unixepoch())`,
    )
      .bind(await sha256("second-session"))
      .run();
    const { csrf_token: csrf } = await inspectAccount(env, token);

    const deleted = await app.request("/api/me", accountMutation("/api/me", token, csrf), env);

    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("set-cookie")).toMatch(
      /triad_session=;.*Max-Age=0;.*Path=\/;.*Secure;.*SameSite=Lax/i,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"),
    ).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(0);

    const second = await app.request("/api/me", accountMutation("/api/me", token, csrf), env);
    expect(second.status).toBe(401);
    await expect(second.json()).resolves.toMatchObject({ error: "login_required" });
  });

  it("rotates an existing session after a successful GitHub callback", async () => {
    const env = await testEnv();
    const oldToken = await seedSession(env);
    const state = "session-state";
    const stateHash = await sha256(state);
    const binding = "session-binding";
    await env.DB.prepare(
      `INSERT INTO oauth_transactions
      (state_hash, kind, client_id, provider, browser_binding_hash, expires_at, created_at)
      VALUES (?, 'session', 'triad-account', 'github', ?, unixepoch() + 600, unixepoch())`,
    )
      .bind(stateHash, await sha256(binding))
      .run();
    stubGithub();

    const response = await app.request(
      `/callback/github?state=${state}&code=provider-code`,
      {
        headers: {
          cookie: `triad_session=${oldToken}; ${preAuthCookieName(stateHash)}=${binding}`,
          "cf-connecting-ip": "203.0.113.8",
        },
      },
      env,
    );

    expect(response.status).toBe(302);
    const cookie = responseCookie(response, "triad_session");
    expect(cookie.header).toContain("Max-Age=604800");
    expect(cookie.header).toContain("Path=/");
    expect(cookie.header).toContain("HttpOnly");
    expect(cookie.header).toContain("Secure");
    expect(cookie.header).toContain("SameSite=Lax");
    const sessionToken = cookie.pair.split("=")[1];
    expect(sessionToken).not.toBe(oldToken);
    const rows = await env.DB.prepare("SELECT session_hash FROM browser_sessions").all<{
      session_hash: string;
    }>();
    expect(rows.results).toEqual([{ session_hash: await sha256(sessionToken) }]);
    expect(rows.results[0].session_hash).not.toContain(sessionToken);
  });

  it("bounds account mutation bodies before parsing", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    const response = await app.request(
      "/session/logout",
      {
        method: "POST",
        headers: {
          origin: issuer,
          cookie: `triad_session=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `csrf_token=${"a".repeat(4097)}`,
      },
      env,
    );
    expect(response.status).toBe(413);
  });

  it("uses POST logout and updates the displayed consent count after revocation", () => {
    const source = process.getBuiltinModule("node:fs").readFileSync("src/pages/me.astro", "utf8");
    expect(source).toContain('fetch("/session/logout", {');
    expect(source).toMatch(/fetch\("\/session\/logout", \{[\s\S]*?method: "POST"/);
    expect(source).toMatch(/row\.remove\(\);[\s\S]*?appCount\.textContent/);
  });

  it("reloads account state safely after stale CSRF, API, or network failures", () => {
    const source = process.getBuiltinModule("node:fs").readFileSync("src/pages/me.astro", "utf8");
    expect(source).toContain("let loadGeneration = 0");
    expect(source).toContain("loadController?.abort()");
    expect(source).toContain("signal: controller.signal");
    expect(source).toMatch(/if \(generation !== loadGeneration\)\s*\{\s*return;\s*\}/);
    expect(source).toContain("async function recoverAccount");
    const recovery = source.slice(
      source.indexOf("async function recoverAccount"),
      source.indexOf("async function revokeClient"),
    );
    expect(recovery).toMatch(/await load\(\);[\s\S]*showError\(reason, fallback\)/);
    expect(source.match(/csrfToken = "";/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const revoke = source.slice(
      source.indexOf("async function revokeClient"),
      source.indexOf("async function logoutAccount"),
    );
    expect(revoke).toContain("await recoverAccount");
    expect(revoke).toContain("finally");
    const logout = source.slice(
      source.indexOf("async function logoutAccount"),
      source.indexOf("load().catch"),
    );
    expect(logout).toContain("await recoverAccount");
    expect(logout).toContain("finally");
    expect(source).toContain("setMutationControls(false)");
  });
});
