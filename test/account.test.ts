import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";
import { createTestDb } from "./d1";

declare const process: {
  getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
};

const issuer = "https://auth.example";
const cleanups: Array<() => void> = [];

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
    SIGNING_PRIVATE_JWK: "unused",
    PAIRWISE_SECRET: "p".repeat(32),
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  };
}

async function seedSession(env: Env, token = "existing-session"): Promise<string> {
  await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_account', unixepoch())").run();
  await env.DB.prepare(`INSERT INTO identities
    (provider, provider_user_id, account_id, created_at)
    VALUES ('github', '42', 'acct_account', unixepoch())`).run();
  await env.DB.prepare(`INSERT INTO browser_sessions
    (session_hash, account_id, expires_at, created_at)
    VALUES (?, 'acct_account', unixepoch() + 2592000, unixepoch())`)
    .bind(await sha256(token)).run();
  return token;
}

async function inspectAccount(env: Env, token: string): Promise<{ csrf_token: string; clients: unknown[] }> {
  const response = await app.request("/api/me", {
    headers: { cookie: `triad_session=${token}` },
  }, env);
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
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  vi.stubGlobal("fetch", fetch);
}

describe("account sessions", () => {
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
    const crossOrigin = await app.request("/session/logout", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        cookie: `triad_session=${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: unreadable,
      duplex: "half",
    } as unknown as RequestInit, env);
    expect(crossOrigin.status).toBe(403);

    const missingCsrf = await app.request(
      "/session/logout",
      accountMutation("/session/logout", token, "wrong-token"),
      env,
    );
    expect(missingCsrf.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count")).toBe(1);
  });

  it("returns a session-bound CSRF token and revokes consent once", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    await env.DB.prepare(`INSERT INTO consents
      (account_id, client_id, scopes, updated_at)
      VALUES ('acct_account', 'triad-demo', '["openid"]', unixepoch())`).run();
    const account = await inspectAccount(env, token);
    expect(account.csrf_token).toHaveLength(43);
    expect(account.clients).toHaveLength(1);

    const crossOrigin = await app.request(
      "/api/me/clients/triad-demo",
      accountMutation("/api/me/clients/triad-demo", token, account.csrf_token, "https://evil.example"),
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
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count")).toBe(0);
  });

  it("rotates an existing session after a successful GitHub callback", async () => {
    const env = await testEnv();
    const oldToken = await seedSession(env);
    const state = "session-state";
    await env.DB.prepare(`INSERT INTO oauth_transactions
      (state_hash, kind, client_id, provider, expires_at, created_at)
      VALUES (?, 'session', 'triad-account', 'github', unixepoch() + 600, unixepoch())`)
      .bind(await sha256(state)).run();
    stubGithub();

    const response = await app.request(`/callback/github?state=${state}&code=provider-code`, {
      headers: { cookie: `triad_session=${oldToken}`, "cf-connecting-ip": "203.0.113.8" },
    }, env);

    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^triad_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const sessionToken = cookie.match(/^triad_session=([^;]+)/)![1];
    expect(sessionToken).not.toBe(oldToken);
    const rows = await env.DB.prepare("SELECT session_hash FROM browser_sessions").all<{ session_hash: string }>();
    expect(rows.results).toEqual([{ session_hash: await sha256(sessionToken) }]);
    expect(rows.results[0].session_hash).not.toContain(sessionToken);
  });

  it("bounds account mutation bodies before parsing", async () => {
    const env = await testEnv();
    const token = await seedSession(env);
    const response = await app.request("/session/logout", {
      method: "POST",
      headers: {
        origin: issuer,
        cookie: `triad_session=${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf_token=${"a".repeat(4097)}`,
    }, env);
    expect(response.status).toBe(413);
  });

  it("uses POST logout and updates the displayed consent count after revocation", () => {
    const source = process.getBuiltinModule("node:fs").readFileSync("src/pages/me.astro", "utf8");
    expect(source).toContain('fetch("/session/logout", {');
    expect(source).toMatch(/fetch\("\/session\/logout", \{[\s\S]*?method: "POST"/);
    expect(source).toMatch(/row\.remove\(\);[\s\S]*?appCount\.textContent/);
  });
});
