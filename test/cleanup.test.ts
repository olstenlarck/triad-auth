import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";
import {
  cleanupExpiredState,
  stateCleanupBatchSize,
  stateCleanupSampleDenominator,
} from "../src/cleanup";
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
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function testDb(): Promise<D1Database> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return db;
}

async function seedCleanupRows(db: D1Database): Promise<void> {
  await db.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_cleanup', 0)").run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO consent_requests
    (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
    SELECT 'request-' || value, 'triad-demo', 'https://expired.example', 'state', 'github', 'challenge',
      '["openid"]', 0, 0 FROM sequence`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, browser_binding_hash, expires_at, created_at)
    SELECT 'state-' || value, 'session', 'triad-account', 'github', 'binding', 0, 0 FROM sequence`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO authorization_codes
    (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge,
      claims_ciphertext, expires_at, consumed_at)
    SELECT 'code-' || value, 'triad-demo', 'https://expired.example', 'acct_cleanup',
      'pid_github_d2ee98e4ac33ccc6387b157c7ed07f5b',
      'challenge', 'v1.expired', 0, NULL FROM sequence`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO device_grants
    (device_code_hash, user_code, client_id, status, claims_ciphertext,
      expires_at, interval_seconds, consumed_at, created_at)
    SELECT 'device-' || value, printf('USER%04d', value), 'triad-demo', 'pending',
      'v1.expired', 0, 5, NULL, 0 FROM sequence`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO browser_sessions (session_hash, account_id, expires_at, created_at)
    SELECT 'session-' || value, 'acct_cleanup', 0, 0 FROM sequence`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
    VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
  ) INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at)
    SELECT 'csrf-' || value, 'purpose-' || value, 0, 0 FROM sequence`,
    )
    .run();
}

describe("ephemeral D1 cleanup", () => {
  it("samples bounded batches whose average capacity exceeds one created row per boundary", async () => {
    const db = await testDb();
    await seedCleanupRows(db);
    const cleanupQueries: string[] = [];
    const tracked = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          if (/^DELETE FROM /i.test(query)) {
            cleanupQueries.push(query);
          }
          return target.prepare(query);
        };
      },
    });
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(0);
      return array;
    });

    await cleanupExpiredState(tracked);

    expect(stateCleanupBatchSize / stateCleanupSampleDenominator).toBeGreaterThan(1);
    expect(cleanupQueries).toHaveLength(6);
    expect(cleanupQueries.every((query) => query.includes(`LIMIT ${stateCleanupBatchSize}`))).toBe(
      true,
    );
    for (const table of [
      "consent_requests",
      "oauth_transactions",
      "authorization_codes",
      "device_grants",
      "browser_sessions",
      "csrf_tokens",
    ]) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(1);
    }
  });

  it("runs at public creation and token boundaries without exposing cleanup state", async () => {
    const db = await testDb();
    const env: Env = {
      DB: db,
      ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
      ISSUER: "https://auth.example",
      SIGNING_PRIVATE_JWK: "unused",
      PAIRWISE_SECRET: "p".repeat(32),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
    };
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(0);
      return array;
    });
    await db
      .prepare(
        `INSERT INTO consent_requests
      (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
      VALUES ('expired-request', 'triad-demo', 'https://expired.example', 'state', 'github', 'challenge',
        '["openid"]', 0, 0)`,
      )
      .run();

    const creation = await app.request(
      "/device/code",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "https://cleanup.example", provider: "github" }),
      },
      env,
    );
    expect(creation.status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM consent_requests").first("count")).toBe(
      0,
    );

    await db
      .prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_token_cleanup', 0)")
      .run();
    await db
      .prepare(
        `INSERT INTO authorization_codes
      (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at, consumed_at)
      VALUES ('expired-code', 'triad-demo', 'https://expired.example', 'acct_token_cleanup',
        'pid_github_d2ee98e4ac33ccc6387b157c7ed07f5b',
        'challenge', 0, NULL)`,
      )
      .run();
    const token = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "unsupported", client_id: "triad-demo" }),
      },
      env,
    );
    expect(token.status).toBe(400);
    await expect(token.json()).resolves.toEqual({ error: "unsupported_grant_type" });
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM authorization_codes").first("count"),
    ).toBe(0);
  });
});
