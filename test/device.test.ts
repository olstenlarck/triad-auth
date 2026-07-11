import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { openClaims, providerSubject, sha256 } from "../src/crypto";
import { preAuthCookieName } from "../src/pre-auth";
import { createCsrfToken } from "../src/security";
import type { Env, ProviderName } from "../src/types";
import { createTestDb } from "./d1";

const issuer = "https://auth.example";
const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";
let signingPrivateJwk: string;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingPrivateJwk = JSON.stringify({ ...(await exportJWK(privateKey)), kid: "test" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
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
    ...overrides,
  };
}

function formRequest(values: Record<string, string>, origin?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(values),
  };
}

function rawFormRequest(body: URLSearchParams, origin?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin ? { origin } : {}),
    },
    body,
  };
}

function deviceTokenRequest(deviceCode: string, clientId = "triad-demo"): RequestInit {
  return formRequest({ grant_type: deviceGrantType, client_id: clientId, device_code: deviceCode });
}

async function seedGrant(env: Env, values: {
  deviceCode?: string;
  userCode?: string;
  clientId?: string;
  status?: "pending" | "approved" | "denied";
  expiresIn?: number;
  interval?: number;
  lastPolled?: boolean;
  consumed?: boolean;
  provider?: ProviderName;
  scopes?: string[];
} = {}): Promise<{ deviceCode: string; deviceHash: string; userCode: string }> {
  const deviceCode = values.deviceCode ?? "d".repeat(43);
  const deviceHash = await sha256(deviceCode);
  const userCode = values.userCode ?? "ABCD2345";
  const status = values.status ?? "pending";
  if (status === "approved") {
    await env.DB.prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES ('acct_device', unixepoch())").run();
    await env.DB.prepare(`INSERT OR IGNORE INTO identities
      (provider, provider_user_id, account_id, created_at) VALUES ('github', '42', 'acct_device', unixepoch())`).run();
  }
  await env.DB.prepare(`INSERT INTO device_grants
    (device_code_hash, user_code, client_id, provider, scopes, status, account_id, provider_sub,
      expires_at, interval_seconds, last_polled_at, consumed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() + ?, ?, ?, ?, unixepoch())`).bind(
      deviceHash,
      userCode,
      values.clientId ?? "triad-demo",
      values.provider ?? "github",
      JSON.stringify(values.scopes ?? ["openid"]),
      status,
      status === "approved" ? "acct_device" : null,
      status === "approved" ? "pid_github_d2ee98e4ac33ccc6387b157c7ed07f5b" : null,
      values.expiresIn ?? 600,
      values.interval ?? 5,
      values.lastPolled ? Math.floor(Date.now() / 1000) : null,
      values.consumed ? Math.floor(Date.now() / 1000) : null,
    ).run();
  return { deviceCode, deviceHash, userCode };
}

async function inspectDevice(env: Env, userCode: string): Promise<string> {
  const response = await app.request(`/api/device/${encodeURIComponent(userCode)}`, undefined, env);
  expect(response.status).toBe(200);
  return (await response.json<{ csrf_token: string }>()).csrf_token;
}

function verifyDevice(
  userCode: string,
  csrf: string,
  origin = issuer,
  provider: ProviderName = "github",
): RequestInit {
  return formRequest({ user_code: userCode, provider, csrf_token: csrf }, origin);
}

function stubGithub(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "temporary", token_type: "bearer", scope: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      login: "mutable-name",
      name: "Device User",
      id: 42,
      node_id: "MDQ6VXNlcjQy",
      avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
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
      user_view_type: "public",
      site_admin: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function responseCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1];
  expect(value).toBeTruthy();
  return `${name}=${value}`;
}

function transitionAfterDeviceStateRead(env: Env, transition: (db: D1Database) => Promise<void>): void {
  const db = env.DB;
  let transitioned = false;
  env.DB = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        if (!query.includes("SELECT client_id, status, expires_at, provider FROM device_grants")) {
          return statement;
        }
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
              return typeof value === "function" ? value.bind(statementTarget) : value;
            }
            return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty !== "first") {
                    const value = Reflect.get(boundTarget, boundProperty, boundReceiver) as unknown;
                    return typeof value === "function" ? value.bind(boundTarget) : value;
                  }
                  return async <T>(column?: string): Promise<T | null> => {
                    const row = column === undefined
                      ? await boundTarget.first<T>()
                      : await boundTarget.first<T>(column);
                    if (!transitioned) {
                      transitioned = true;
                      await transition(db);
                    }
                    return row;
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

describe("device authorization", () => {
  it("issues RFC-shaped random codes and stores only the device-code hash", async () => {
    const env = await testEnv();
    const response = await app.request("/device/code", formRequest({
      client_id: "triad-demo",
      provider: "github",
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>();
    expect(body).toMatchObject({
      verification_uri: `${issuer}/device/verify`,
      expires_in: 600,
      interval: 5,
    });
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new URL(body.verification_uri_complete).searchParams.get("user_code")).toBe(body.user_code);

    const row = await env.DB.prepare("SELECT device_code_hash, user_code FROM device_grants").first<{
      device_code_hash: string;
      user_code: string;
    }>();
    expect(row).toEqual({ device_code_hash: await sha256(body.device_code), user_code: body.user_code.replace("-", "") });
    expect(row?.device_code_hash).not.toContain(body.device_code);
  });

  it("requires a provider and rejects unavailable providers before creating a grant", async () => {
    const env = await testEnv();
    const requests: Record<string, string>[] = [
      { client_id: "triad-demo" },
      { client_id: "triad-demo", provider: "twitter" },
    ];
    for (const values of requests) {
      const response = await app.request("/device/code", formRequest(values), env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(0);
  });

  it("persists a selected Twitter provider and canonical scopes on the grant", async () => {
    const env = await testEnv({
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });
    const response = await app.request("/device/code", formRequest({
      client_id: "triad-demo",
      provider: "twitter",
      scope: "name openid handle handle",
    }), env);

    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT provider, scopes FROM device_grants").first();
    expect(row).toEqual({ provider: "twitter", scopes: '["openid","handle","name"]' });
  });

  it("rejects an unknown, oversized, or provider-disallowed issuance client", async () => {
    const env = await testEnv();
    await env.DB.prepare(`INSERT INTO clients
      (client_id, name, redirect_uris, providers, created_at) VALUES ('blocked', 'Blocked', '[]', '[]', unixepoch())`).run();

    for (const clientId of ["unknown", "a".repeat(129), "blocked"]) {
      const response = await app.request("/device/code", formRequest({ client_id: clientId, provider: "github" }), env);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: clientId === "blocked" ? "unauthorized_client" : "invalid_client",
      });
    }
  });

  it("regenerates a colliding user code and inserts the next candidate", async () => {
    const env = await testEnv();
    await seedGrant(env, { deviceCode: "e".repeat(43), userCode: "AAAAAAAA" });
    let userCodeCalls = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      const bytes = array as Uint8Array;
      bytes.fill(bytes.length === 8 && userCodeCalls++ === 0 ? 0 : 1);
      return array;
    });

    const response = await app.request("/device/code", formRequest({ client_id: "triad-demo", provider: "github" }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user_code: "BBBB-BBBB" });
    expect(userCodeCalls).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(2);
  });

  it("bounds user-code collision retries", async () => {
    const env = await testEnv();
    await seedGrant(env, { deviceCode: "e".repeat(43), userCode: "AAAAAAAA" });
    let userCodeCalls = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      const bytes = array as Uint8Array;
      if (bytes.length === 8) userCodeCalls++;
      bytes.fill(0);
      return array;
    });

    const response = await app.request("/device/code", formRequest({ client_id: "triad-demo", provider: "github" }), env);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: "server_error" });
    expect(userCodeCalls).toBe(5);
  });

  it.each(["client_id", "provider", "scope"])("rejects duplicate device issuance %s parameters", async (duplicate) => {
    const env = await testEnv();
    const body = new URLSearchParams({ client_id: "triad-demo", provider: "github", scope: "openid" });
    body.append(duplicate, body.get(duplicate)!);

    const response = await app.request("/device/code", rawFormRequest(body), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(0);
  });

  it("rejects an unsupported device scope", async () => {
    const env = await testEnv({
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });
    const response = await app.request("/device/code", formRequest({
      client_id: "triad-demo",
      provider: "twitter",
      scope: "openid email",
    }), env);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_scope" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(0);
  });

  it("enforces form encoding and the 4096-byte body limit on device POSTs", async () => {
    const env = await testEnv();
    const wrongType = await app.request("/device/code", { method: "POST", body: "client_id=triad-demo" }, env);
    expect(wrongType.status).toBe(400);

    for (const path of ["/device/code", "/device/verify"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { origin: issuer, "content-type": "application/x-www-form-urlencoded" },
        body: `value=${"a".repeat(4097)}`,
      }, env);
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
  });

  it("normalizes inspected user codes and rotates a grant-bound CSRF token", async () => {
    const env = await testEnv();
    const { deviceHash } = await seedGrant(env);
    const first = await app.request("/api/device/abcd-2345", undefined, env);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      client_name: string;
      provider: string;
      scopes: string[];
      expires_in: number;
      csrf_token: string;
    }>();
    expect(firstBody.client_name).toBe("Triad demo");
    expect(firstBody.provider).toBe("github");
    expect(firstBody.scopes).toEqual(["openid"]);
    expect(firstBody.expires_in).toBeGreaterThan(0);
    expect(firstBody.csrf_token).toHaveLength(43);

    const second = await inspectDevice(env, "ABCD2345");
    expect(second).not.toBe(firstBody.csrf_token);
    const row = await env.DB.prepare("SELECT purpose, COUNT(*) AS count FROM csrf_tokens GROUP BY purpose")
      .first<{ purpose: string; count: number }>();
    expect(row).toEqual({ purpose: `device:${deviceHash}`, count: 1 });
  });

  it("rejects a device verification provider mismatch without consuming CSRF or creating state", async () => {
    const env = await testEnv({
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });
    const { userCode } = await seedGrant(env, { provider: "twitter" });
    const csrf = await inspectDevice(env, userCode);

    const mismatch = await app.request("/device/verify", verifyDevice(userCode, csrf), env);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(0);

    const accepted = await app.request("/device/verify", verifyDevice(userCode, csrf, issuer, "twitter"), env);
    expect(accepted.status).toBe(200);
  });

  it("persists Twitter verifier and grant scopes in the device transaction", async () => {
    const env = await testEnv({
      TWITTER_CLIENT_ID: "twitter-client",
      TWITTER_CLIENT_SECRET: "twitter-secret",
    });
    const { userCode } = await seedGrant(env, { provider: "twitter", scopes: ["openid", "handle"] });
    const csrf = await inspectDevice(env, userCode);

    const response = await app.request("/device/verify", verifyDevice(userCode, csrf, issuer, "twitter"), env);
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT provider, provider_verifier, provider_nonce, scopes
      FROM oauth_transactions`).first();
    expect(row).toEqual({
      provider: "twitter",
      provider_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      provider_nonce: null,
      scopes: '["openid","handle"]',
    });
  });

  it("carries encrypted minimal claims and canonical scopes through device exchange", async () => {
    const env = await testEnv();
    const { deviceCode, deviceHash, userCode } = await seedGrant(env, {
      scopes: ["openid", "handle", "name"],
    });
    const csrf = await inspectDevice(env, userCode);
    const verified = await app.request("/device/verify", verifyDevice(userCode, csrf), env);
    const state = new URL((await verified.json<{ redirect_to: string }>()).redirect_to).searchParams.get("state")!;
    const cookieName = preAuthCookieName(await sha256(state));
    const binding = responseCookie(verified, cookieName);
    stubGithub();

    const callback = await app.request(`/callback/github?state=${state}&code=provider-code`, {
      headers: { cookie: binding },
    }, env);
    expect(callback.status).toBe(200);
    const stored = await env.DB.prepare(`SELECT scopes, claims_ciphertext FROM device_grants
      WHERE device_code_hash = ?`).bind(deviceHash).first<{ scopes: string; claims_ciphertext: string }>();
    expect(stored?.scopes).toBe('["openid","handle","name"]');
    expect(stored?.claims_ciphertext).not.toContain("mutable-name");
    await expect(openClaims(env.PAIRWISE_SECRET, deviceHash, stored!.claims_ciphertext)).resolves.toEqual({
      preferred_username: "mutable-name",
      name: "Device User",
    });

    const token = await app.request("/token", deviceTokenRequest(deviceCode), env);
    const body = await token.json<{ id_token: string; scope: string }>();
    expect(body.scope).toBe("openid handle name");
    expect(decodeJwt(body.id_token)).toMatchObject({
      preferred_username: "mutable-name",
      name: "Device User",
    });
    expect(decodeJwt(body.id_token)).not.toHaveProperty("email");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants WHERE device_code_hash = ?")
      .bind(deviceHash).first("count")).toBe(0);
  });

  it("denies a device grant when a mandatory profile value is unavailable", async () => {
    const env = await testEnv();
    const { deviceCode, userCode } = await seedGrant(env, { scopes: ["openid", "name"] });
    const csrf = await inspectDevice(env, userCode);
    const verified = await app.request("/device/verify", verifyDevice(userCode, csrf), env);
    const state = new URL((await verified.json<{ redirect_to: string }>()).redirect_to).searchParams.get("state")!;
    const stateHash = await sha256(state);
    const binding = responseCookie(verified, preAuthCookieName(stateHash));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, name: null }), { status: 200 })));

    const callback = await app.request(`/callback/github?state=${state}&code=provider-code`, {
      headers: { cookie: binding },
    }, env);

    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("<h1>Denied</h1>");
    expect(logged).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT status FROM device_grants").first("status")).toBe("denied");
    const poll = await app.request("/token", deviceTokenRequest(deviceCode), env);
    await expect(poll.json()).resolves.toMatchObject({ error: "access_denied" });
  });

  it("rejects invalid or oversized user codes without issuing CSRF", async () => {
    const env = await testEnv();
    for (const code of ["short", "a".repeat(33)]) {
      const response = await app.request(`/api/device/${code}`, undefined, env);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM csrf_tokens").first("count")).toBe(0);
  });

  it("checks exact origin before reading the verification body", async () => {
    const env = await testEnv();
    const unreadable = new ReadableStream({
      pull(controller) {
        controller.error(new Error("body must not be read"));
      },
    });
    const response = await app.request("/device/verify", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: unreadable,
      duplex: "half",
    } as unknown as RequestInit, env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("requires a purpose-bound one-time CSRF token before starting GitHub", async () => {
    const env = await testEnv();
    const { userCode } = await seedGrant(env);
    const csrf = await inspectDevice(env, userCode);

    const invalid = await app.request("/device/verify", verifyDevice(userCode, "wrong-token"), env);
    expect(invalid.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(0);

    const responses = await Promise.all([
      app.request("/device/verify", verifyDevice(userCode, csrf), env),
      app.request("/device/verify", verifyDevice(userCode, csrf), env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(1);
    await expect(responses.find((response) => response.status === 200)?.json()).resolves.toMatchObject({
      redirect_to: expect.stringMatching(/^https:\/\/github\.com\/login\/oauth\/authorize\?/),
    });
  });

  it.each(["user_code", "provider", "csrf_token"])(
    "rejects duplicate device verification %s parameters",
    async (duplicate) => {
      const env = await testEnv();
      const { userCode } = await seedGrant(env);
      const csrf = await inspectDevice(env, userCode);
      const body = new URLSearchParams({ user_code: userCode, provider: "github", csrf_token: csrf });
      body.append(duplicate, body.get(duplicate)!);

      const response = await app.request("/device/verify", rawFormRequest(body, issuer), env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(0);
    },
  );

  it("revalidates the client provider allowlist during browser verification", async () => {
    const env = await testEnv();
    await env.DB.prepare(`INSERT INTO clients
      (client_id, name, redirect_uris, providers, created_at) VALUES ('blocked', 'Blocked', '[]', '[]', unixepoch())`).run();
    const { deviceHash, userCode } = await seedGrant(env, { clientId: "blocked" });
    const csrf = await createCsrfToken(env.DB, `device:${deviceHash}`);

    const response = await app.request("/device/verify", verifyDevice(userCode, csrf), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "unauthorized_client",
      error_description: "provider not allowed for client",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(0);
  });

  it("binds device confirmation callback to the browser that confirmed the code", async () => {
    const env = await testEnv();
    const { userCode } = await seedGrant(env);
    const csrf = await inspectDevice(env, userCode);
    const verified = await app.request("/device/verify", verifyDevice(userCode, csrf), env);
    expect(verified.status).toBe(200);
    const state = new URL((await verified.json<{ redirect_to: string }>()).redirect_to).searchParams.get("state")!;
    const cookieName = preAuthCookieName(await sha256(state));
    const binding = responseCookie(verified, cookieName);
    stubGithub();

    const missingBrowser = await app.request(`/callback/github?state=${state}&code=provider-code`, undefined, env);
    expect(missingBrowser.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions WHERE state_hash = ?")
      .bind(await sha256(state)).first("count")).toBe(1);

    const completed = await app.request(`/callback/github?state=${state}&code=provider-code`, {
      headers: { cookie: binding },
    }, env);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("set-cookie")).toMatch(new RegExp(`${cookieName}=;.*Max-Age=0`, "i"));
  });

  it("approves a pending grant only once across competing callbacks", async () => {
    const env = await testEnv();
    const { deviceHash } = await seedGrant(env);
    await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_device', unixepoch())").run();
    await env.DB.prepare(`INSERT INTO identities
      (provider, provider_user_id, account_id, created_at) VALUES ('github', '42', 'acct_device', unixepoch())`).run();
    const states = ["first-state", "second-state"];
    const stateHashes = await Promise.all(states.map(sha256));
    const bindings = ["first-binding", "second-binding"];
    for (const [index, state] of states.entries()) {
      await env.DB.prepare(`INSERT INTO oauth_transactions
        (state_hash, kind, client_id, provider, device_code_hash, browser_binding_hash, expires_at, created_at)
        VALUES (?, 'device', 'triad-demo', 'github', ?, ?, unixepoch() + 600, unixepoch())`)
        .bind(stateHashes[index], deviceHash, await sha256(bindings[index])).run();
    }
    stubGithub();

    const responses = await Promise.all(states.map((state, index) => app.request(
      `/callback/github?state=${state}&code=provider-code`, {
        headers: { cookie: `${preAuthCookieName(stateHashes[index])}=${bindings[index]}` },
      }, env,
    )));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    await expect(responses.find((response) => response.status === 400)!.json())
      .resolves.toMatchObject({ error: "invalid_grant" });
    const grant = await env.DB.prepare("SELECT status, account_id, provider_sub FROM device_grants WHERE device_code_hash = ?")
      .bind(deviceHash).first();
    expect(grant).toEqual({
      status: "approved",
      account_id: "acct_device",
      provider_sub: await providerSubject("p".repeat(32), "github", "42"),
    });
  });

  it("consumes a GitHub denial callback and makes the device poll return access_denied", async () => {
    const env = await testEnv();
    const { deviceCode, deviceHash } = await seedGrant(env);
    const state = "device-denial-state";
    const stateHash = await sha256(state);
    const binding = "device-denial-binding";
    const otherStateHash = await sha256("other-device-state");
    const otherCookieName = preAuthCookieName(otherStateHash);
    await env.DB.prepare(`INSERT INTO oauth_transactions
      (state_hash, kind, client_id, provider, device_code_hash, browser_binding_hash, expires_at, created_at)
      VALUES (?, 'device', 'triad-demo', 'github', ?, ?, unixepoch() + 600, unixepoch())`)
      .bind(stateHash, deviceHash, await sha256(binding)).run();

    const denied = await app.request(
      `/callback/github?state=${state}&error=access_denied`, {
        headers: {
          cookie: `${preAuthCookieName(stateHash)}=${binding}; ${otherCookieName}=other-binding`,
        },
      }, env,
    );
    expect(denied.status).toBe(200);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(denied.headers.get("set-cookie")).toContain(`${preAuthCookieName(stateHash)}=;`);
    expect(denied.headers.get("set-cookie")).not.toContain(`${otherCookieName}=;`);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first("count")).toBe(0);

    const poll = await app.request("/token", deviceTokenRequest(deviceCode), env);
    await expect(poll.json()).resolves.toMatchObject({ error: "access_denied" });
  });
});

describe("device token exchange", () => {
  it.each(["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "device_code"])(
    "rejects duplicate token %s parameters",
    async (duplicate) => {
      const env = await testEnv();
      const body = new URLSearchParams({
        grant_type: deviceGrantType,
        client_id: "triad-demo",
        device_code: "f".repeat(43),
        code: "code",
        code_verifier: "A".repeat(43),
        redirect_uri: "http://localhost:8787/demo/callback/",
      });
      body.append(duplicate, body.get(duplicate)!);

      const response = await app.request("/token", rawFormRequest(body), env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    },
  );

  it.each([
    ["pending", "authorization_pending"],
    ["denied", "access_denied"],
  ] as const)("returns %s as %s", async (status, expected) => {
    const env = await testEnv();
    const { deviceCode } = await seedGrant(env, { status });
    const response = await app.request("/token", deviceTokenRequest(deviceCode), env);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: expected });
  });

  it("expires old grants and bounds the device code before hashing", async () => {
    const env = await testEnv();
    const { deviceCode } = await seedGrant(env, { expiresIn: -1 });
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(0);
      return array;
    });

    const expired = await app.request("/token", deviceTokenRequest(deviceCode), env);
    await expect(expired.json()).resolves.toMatchObject({ error: "expired_token" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(0);
    const oversized = await app.request("/token", deviceTokenRequest("a".repeat(129)), env);
    await expect(oversized.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("distinguishes fabricated and client-mismatched device codes from expired grants", async () => {
    const env = await testEnv();
    await env.DB.prepare(`INSERT INTO clients
      (client_id, name, redirect_uris, providers, created_at)
      VALUES ('other-client', 'Other', '[]', '["github"]', unixepoch())`).run();
    const { deviceCode } = await seedGrant(env);

    const fabricated = await app.request("/token", deviceTokenRequest("f".repeat(43)), env);
    await expect(fabricated.json()).resolves.toMatchObject({ error: "invalid_grant" });
    const mismatched = await app.request("/token", deviceTokenRequest(deviceCode, "other-client"), env);
    await expect(mismatched.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("adds five seconds after an early poll", async () => {
    const env = await testEnv();
    const { deviceCode, deviceHash } = await seedGrant(env, { lastPolled: true });
    const response = await app.request("/token", deviceTokenRequest(deviceCode), env);

    await expect(response.json()).resolves.toMatchObject({ error: "slow_down" });
    expect(await env.DB.prepare("SELECT interval_seconds FROM device_grants WHERE device_code_hash = ?")
      .bind(deviceHash).first("interval_seconds")).toBe(10);
  });

  it("allows one concurrent first poll and slows the other", async () => {
    const env = await testEnv();
    const { deviceCode, deviceHash } = await seedGrant(env);

    const responses = await Promise.all([
      app.request("/token", deviceTokenRequest(deviceCode), env),
      app.request("/token", deviceTokenRequest(deviceCode), env),
    ]);
    const errors = await Promise.all(responses.map((response) => response.json<{ error: string }>()));
    expect(errors.map(({ error }) => error).sort()).toEqual(["authorization_pending", "slow_down"]);
    expect(await env.DB.prepare("SELECT interval_seconds FROM device_grants WHERE device_code_hash = ?")
      .bind(deviceHash).first("interval_seconds")).toBe(10);
  });

  it("adds five seconds for every repeated early poll", async () => {
    const env = await testEnv();
    const { deviceCode, deviceHash } = await seedGrant(env, { lastPolled: true });

    for (const expectedInterval of [10, 15]) {
      const response = await app.request("/token", deviceTokenRequest(deviceCode), env);
      await expect(response.json()).resolves.toMatchObject({ error: "slow_down" });
      expect(await env.DB.prepare("SELECT interval_seconds FROM device_grants WHERE device_code_hash = ?")
        .bind(deviceHash).first("interval_seconds")).toBe(expectedInterval);
    }
  });

  it.each(["approved", "denied"] as const)(
    "reclassifies a pending grant that becomes %s immediately after state read",
    async (status) => {
      const env = await testEnv();
      const { deviceCode, deviceHash } = await seedGrant(env);
      if (status === "approved") {
        await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES ('acct_device', unixepoch())").run();
      }
      transitionAfterDeviceStateRead(env, async (db) => {
        await db.prepare(`UPDATE device_grants SET status = ?, account_id = ?, provider_sub = ?
          WHERE device_code_hash = ?`).bind(
            status,
            status === "approved" ? "acct_device" : null,
            status === "approved" ? "pid_github_d2ee98e4ac33ccc6387b157c7ed07f5b" : null,
            deviceHash,
          ).run();
      });

      const response = await app.request("/token", deviceTokenRequest(deviceCode), env);
      if (status === "approved") {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ token_type: "Bearer" });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
      }
    },
  );

  it("atomically consumes an approved grant before issuing one token", async () => {
    const env = await testEnv();
    const { deviceCode } = await seedGrant(env, { status: "approved" });

    const responses = await Promise.all([
      app.request("/token", deviceTokenRequest(deviceCode), env),
      app.request("/token", deviceTokenRequest(deviceCode), env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const token = responses.find((response) => response.status === 200)!;
    const rejected = responses.find((response) => response.status === 400)!;
    await expect(token.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 300 });
    await expect(rejected.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM consents WHERE account_id = 'acct_device'")
      .first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants").first("count")).toBe(0);
  });

  it("deletes an approved grant before malformed claim ciphertext decryption", async () => {
    const env = await testEnv();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deviceCode, deviceHash } = await seedGrant(env, { status: "approved" });
    await env.DB.prepare("UPDATE device_grants SET claims_ciphertext = 'v1.invalid' WHERE device_code_hash = ?")
      .bind(deviceHash).run();
    const randomValues = crypto.getRandomValues.bind(crypto);
    let cleanupDraws = 0;
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      if (array.byteLength === 1) {
        cleanupDraws++;
        (array as Uint8Array).fill(255);
        return array;
      }
      return randomValues(array);
    });

    try {
      const response = await app.request("/token", deviceTokenRequest(deviceCode), env);

      expect(response.status).toBe(500);
      expect(logged).toHaveBeenCalledWith("OAuth route failed");
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_grants WHERE device_code_hash = ?")
        .bind(deviceHash).first("count")).toBe(0);
      const replay = await app.request("/token", deviceTokenRequest(deviceCode), env);
      expect(replay.status).toBe(400);
      await expect(replay.json()).resolves.toEqual({ error: "invalid_grant" });
      expect(cleanupDraws).toBeGreaterThan(0);
    } finally {
      random.mockRestore();
    }
  });

  it("rejects token exchange after the client loses GitHub permission", async () => {
    const env = await testEnv();
    const { deviceCode } = await seedGrant(env, { status: "approved" });
    await env.DB.prepare("UPDATE clients SET providers = '[]' WHERE client_id = 'triad-demo'").run();

    const response = await app.request("/token", deviceTokenRequest(deviceCode), env);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(await env.DB.prepare("SELECT consumed_at FROM device_grants").first("consumed_at")).toBeNull();
  });
});
