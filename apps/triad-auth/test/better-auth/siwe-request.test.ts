import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

function emptyDatabase(): D1Database {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    all: async () => ({ success: true, results: [], meta }),
    first: async () => null,
    raw: () => {
      throw new Error("Unexpected raw query");
    },
    run: async () => ({ success: true, results: [], meta }),
  };

  return {
    prepare: () => statement,
    // The rate limiter reads one allowed bucket row from each batch result.
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const allowed = { success: true as const, results: [{ lastRequest: 0 }], meta };

      return statements.map(() => allowed) as Array<D1Result<T>>;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => {
      throw new Error("Unexpected session");
    },
    dump: () => {
      throw new Error("Unexpected dump");
    },
  };
}

function createEnv(): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: emptyDatabase(),
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    IDENTIFIER_SECRET: "identifier-secret-with-enough-entropy-1234567890",
    RATE_LIMIT_SECRET: "rate-limit-secret-with-enough-entropy-1234567890",
    ENCRYPTION_SECRETS:
      '{"active":"v1","secrets":{"v1":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    TWITTER_CLIENT_ID: "twitter-client-id",
    TWITTER_CLIENT_SECRET: "twitter-client-secret",
  };
}

async function postSiwe(path: string, body: string): Promise<Response> {
  const env = createEnv();
  const auth = createTriadAuth(env, createTriadConfiguration(env));

  return auth.handler(
    new Request(`https://auth.example.com/api/auth${path}`, {
      method: "POST",
      headers: { origin: "https://auth.example.com", "content-type": "application/json" },
      body,
    }),
  );
}

describe("SIWE request bodies", () => {
  it("issues a nonce for the empty body the account page sends", async () => {
    const response = await postSiwe("/siwe/nonce", "{}");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ nonce: expect.any(String) });
  });

  it("accepts the message and signature body the account page sends", async () => {
    const response = await postSiwe(
      "/siwe/verify",
      JSON.stringify({ message: "not a SIWE message", signature: "0x00" }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects the wallet fields the account page used to send", async () => {
    const response = await postSiwe(
      "/siwe/nonce",
      JSON.stringify({ walletAddress: "0x0000000000000000000000000000000000000001", chainId: 1 }),
    );

    expect(response.status).toBe(400);
  });
});
