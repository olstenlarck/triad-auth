import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import { enforceRateLimit } from "../src/rate-limit";
import type { Env } from "../src/types";
import { createTestDb } from "./d1";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function testDb(): Promise<D1Database> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return db;
}

async function testEnv(): Promise<Env> {
  return {
    DB: await testDb(),
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ISSUER: "https://auth.example",
    SIGNING_PRIVATE_JWK: "unused",
    PAIRWISE_SECRET: "p".repeat(32),
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  };
}

const ipHeaders = { "cf-connecting-ip": "203.0.113.10" };

async function expectLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  await expect(response.json()).resolves.toMatchObject({ error: "temporarily_unavailable" });
}

describe("D1 rate limiter", () => {
  it("accepts exactly the limit, rejects one, and bounds the stored count", async () => {
    const db = await testDb();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(enforceRateLimit(db, "authorization", "203.0.113.4", 3, 60)).resolves.toBe(true);
    }
    await expect(enforceRateLimit(db, "authorization", "203.0.113.4", 3, 60)).resolves.toBe(false);

    const row = await db.prepare("SELECT key_hash, count FROM rate_limits WHERE bucket = 'authorization'")
      .first<{ key_hash: string; count: number }>();
    expect(row).toEqual({ key_hash: await sha256("203.0.113.4"), count: 3 });
    expect(JSON.stringify(row)).not.toContain("203.0.113.4");
  });

  it("uses a capped atomic upsert under local contention", async () => {
    const db = await testDb();

    const accepted = await Promise.all(Array.from(
      { length: 8 },
      () => enforceRateLimit(db, "callback", "198.51.100.9", 3, 60),
    ));

    expect(accepted.filter(Boolean)).toHaveLength(3);
    expect(await db.prepare("SELECT count FROM rate_limits WHERE bucket = 'callback'").first("count")).toBe(3);
  });

  it("accepts again in the next window without requiring cleanup", async () => {
    const db = await testDb();
    await expect(enforceRateLimit(db, "device-issue", "192.0.2.7", 1, 60)).resolves.toBe(true);
    await expect(enforceRateLimit(db, "device-issue", "192.0.2.7", 1, 60)).resolves.toBe(false);

    vi.advanceTimersByTime(60_000);

    await expect(enforceRateLimit(db, "device-issue", "192.0.2.7", 1, 60)).resolves.toBe(true);
    const rows = await db.prepare(`SELECT window_start, count FROM rate_limits
      WHERE bucket = 'device-issue'`).all<{ window_start: number; count: number }>();
    expect(rows.results.at(-1)).toEqual({
      window_start: Math.floor(Date.now() / 60_000) * 60,
      count: 1,
    });
  });

  it("does not run cleanup on an ordinary limiter decision", async () => {
    const db = await testDb();
    let cleanupQueries = 0;
    const tracked = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          if (/^DELETE FROM rate_limits/i.test(query)) cleanupQueries++;
          return target.prepare(query);
        };
      },
    });
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(8);
      return array;
    });

    await enforceRateLimit(tracked, "authorization", "203.0.113.4", 3, 60);

    expect(cleanupQueries).toBe(0);
  });

  it("occasionally removes at most 100 expired rows globally without deleting active rows", async () => {
    const db = await testDb();
    const columns = await db.prepare("PRAGMA table_info(rate_limits)").all<{ name: string }>();
    if (!columns.results.some(({ name }) => name === "expires_at")) {
      await db.prepare("ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER").run();
    }
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`WITH RECURSIVE sequence(value) AS (
      VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 150
    )
    INSERT INTO rate_limits (bucket, key_hash, window_start, count, expires_at)
    SELECT 'stale-' || value, 'key-' || value, ?, 1, ? FROM sequence`)
      .bind(now - 120, now - 1).run();
    await db.prepare(`INSERT INTO rate_limits (bucket, key_hash, window_start, count, expires_at)
      VALUES ('active', 'active-key', ?, 1, ?)`).bind(now, now + 60).run();
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(7);
      return array;
    });

    await enforceRateLimit(db, "cleanup-trigger", "203.0.113.4", 3, 60);

    expect(await db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE expires_at <= ?")
      .bind(now).first("count")).toBe(50);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE bucket = 'active'")
      .first("count")).toBe(1);
  });
});

describe("public route rate limits", () => {
  it("stores secret-bound IP keys that differ across broker secrets", async () => {
    const first = await testEnv();
    const second = await testEnv();
    second.PAIRWISE_SECRET = "q".repeat(32);
    await app.request("/authorize?provider=github", { headers: ipHeaders }, first);
    await app.request("/authorize?provider=github", { headers: ipHeaders }, second);
    const firstHash = await first.DB.prepare("SELECT key_hash FROM rate_limits").first<string>("key_hash");
    const secondHash = await second.DB.prepare("SELECT key_hash FROM rate_limits").first<string>("key_hash");

    expect(firstHash).not.toBe(await sha256("203.0.113.10"));
    expect(secondHash).not.toBe(firstHash);
  });

  it("keeps missing-IP local requests in one shared fallback bucket", async () => {
    const env = await testEnv();
    await app.request("/authorize?provider=github", undefined, env);
    await app.request("/authorize?provider=github", undefined, env);

    const rows = await env.DB.prepare("SELECT count FROM rate_limits WHERE bucket = 'authorization-start'")
      .all<{ count: number }>();
    expect(rows.results).toEqual([{ count: 2 }]);
  });

  it("limits account authorization starts to 10 per minute per IP", async () => {
    const env = await testEnv();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await app.request("/session/start/github", { headers: ipHeaders }, env)).status).toBe(302);
    }
    await expectLimited(await app.request("/session/start/github", { headers: ipHeaders }, env));
    expect((await app.request("/session/start/github", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    }, env)).status).toBe(302);
  });

  it("limits downstream authorization starts to 20 per minute per IP", async () => {
    const env = await testEnv();
    for (let attempt = 0; attempt < 20; attempt++) {
      expect((await app.request("/authorize?provider=github", { headers: ipHeaders }, env)).status).toBe(400);
    }
    await expectLimited(await app.request("/authorize?provider=github", { headers: ipHeaders }, env));
  });

  it("limits device issuance to 10 per minute per IP", async () => {
    const env = await testEnv();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await app.request("/device/code", { method: "POST", headers: ipHeaders }, env)).status).toBe(400);
    }
    await expectLimited(await app.request("/device/code", { method: "POST", headers: ipHeaders }, env));
  });

  it("limits device inspection to 30 per minute per IP", async () => {
    const env = await testEnv();
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await app.request("/api/device/INVALID", { headers: ipHeaders }, env)).status).toBe(404);
    }
    await expectLimited(await app.request("/api/device/INVALID", { headers: ipHeaders }, env));
  });

  it("limits provider callbacks to 30 per minute per IP", async () => {
    const env = await testEnv();
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await app.request("/callback/github", { headers: ipHeaders }, env)).status).toBe(400);
    }
    await expectLimited(await app.request("/callback/github", { headers: ipHeaders }, env));
  });

  it("limits only device token polls and preserves the OAuth slow_down response", async () => {
    const env = await testEnv();
    const deviceRequest = {
      method: "POST",
      headers: { ...ipHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "triad-demo",
        device_code: "d".repeat(43),
      }),
    };
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await app.request("/token", deviceRequest, env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    }
    const limited = await app.request("/token", deviceRequest, env);
    expect(limited.status).toBe(400);
    await expect(limited.json()).resolves.toMatchObject({ error: "slow_down" });

    const authorizationCode = await app.request("/token", {
      method: "POST",
      headers: { ...ipHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "triad-demo",
        redirect_uri: "http://localhost:8787/demo/callback/",
        code: "invalid",
        code_verifier: "A".repeat(43),
      }),
    }, env);
    await expect(authorizationCode.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("does not write database or OAuth artifacts to error logs", async () => {
    const env = await testEnv();
    env.DB = {
      prepare() {
        throw new Error("client_secret=github-secret&code=provider-artifact");
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const query = new URLSearchParams({
      provider: "github",
      client_id: "triad-demo",
      redirect_uri: "http://localhost:8787/demo/callback/",
      state: "state",
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await app.request(`/authorize?${query}`, { headers: ipHeaders }, env);

    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat().map(String).join(" ")).not.toMatch(/github-secret|provider-artifact/);
  });
});
