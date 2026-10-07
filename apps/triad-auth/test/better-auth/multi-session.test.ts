import type { oauthProvider } from "@better-auth/oauth-provider";
import type { HookEndpointContext } from "better-auth";
import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";
import {
  createPasskeyAuthentication,
  hasOtherDeviceSession,
  withoutActiveSessionCookies,
} from "../../src/better-auth/identity";

const SECRET = "test-secret-that-is-at-least-32-characters";
const SESSION_COOKIE = "__Secure-better-auth.session_token";

function recordingDatabase(queries: string[]): D1Database {
  const meta = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
  const statement = (query: string): D1PreparedStatement => {
    const prepared: D1PreparedStatement = {
      bind: () => prepared,
      all: async () => ({ success: true, results: [], meta }),
      first: async () => null,
      raw: () => {
        throw new Error("Unexpected raw query");
      },
      run: async () => ({ success: true, results: [], meta }),
    };
    queries.push(query);

    return prepared;
  };

  return {
    prepare: statement,
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

function createEnv(database: D1Database): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: database,
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: SECRET,
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

async function signedCookieValue(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));

  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`);
}

async function sessionQueries(path: string): Promise<string[]> {
  const queries: string[] = [];
  const env = createEnv(recordingDatabase(queries));
  const auth = createTriadAuth(env, createTriadConfiguration(env));
  const cookie = `${SESSION_COOKIE}=${await signedCookieValue("active-session-token")}`;

  await auth.handler(
    new Request(`https://auth.example.com/api/auth${path}`, {
      headers: { cookie, origin: "https://auth.example.com" },
    }),
  );

  return queries.filter((query) => query.includes('from "session"'));
}

describe("Triad multi-session", () => {
  it("keeps one signed-in account per Identity Source sign-in", () => {
    const configuration = createTriadConfiguration(createEnv(recordingDatabase([])));
    const provider = configuration.plugins.find(
      (plugin): plugin is ReturnType<typeof oauthProvider> => plugin.id === "oauth-provider",
    );

    expect(configuration.plugins.map((plugin) => plugin.id)).toContain("multi-session");
    expect(provider?.options.selectAccount?.page).toBe("/me");
  });

  it("asks for account selection only when another account is signed in", () => {
    const active = "Active-Token";
    const activeCookie = `${SESSION_COOKIE}_multi-active-token=signed`;
    const otherCookie = `${SESSION_COOKIE}_multi-other-token=signed`;

    expect(hasOtherDeviceSession(new Headers(), active)).toBe(false);
    expect(hasOtherDeviceSession(new Headers({ cookie: activeCookie }), active)).toBe(false);
    expect(
      hasOtherDeviceSession(new Headers({ cookie: `${activeCookie}; ${otherCookie}` }), active),
    ).toBe(true);
  });

  it("removes only the active session cookies", () => {
    const headers = new Headers({
      cookie: `${SESSION_COOKIE}=active; ${SESSION_COOKIE}_multi-a=one; theme=dark`,
      origin: "https://auth.example.com",
    });

    const stripped = withoutActiveSessionCookies(headers, [SESSION_COOKIE]);

    expect(stripped.get("cookie")).toBe(`${SESSION_COOKIE}_multi-a=one; theme=dark`);
    expect(stripped.get("origin")).toBe("https://auth.example.com");
    expect(headers.get("cookie")).toContain(`${SESSION_COOKIE}=active`);
  });

  it("reads the signed session for ordinary requests", async () => {
    await expect(sessionQueries("/get-session")).resolves.not.toHaveLength(0);
  });

  it("offers every discoverable passkey regardless of the active account", async () => {
    await expect(sessionQueries("/passkey/generate-authenticate-options")).resolves.toHaveLength(0);
  });

  it("registers an Identity Passkey without attaching it to the active account", async () => {
    await expect(
      sessionQueries("/passkey/generate-register-options?context=alice"),
    ).resolves.toHaveLength(0);
    await expect(
      sessionQueries("/passkey/generate-register-options?name=laptop"),
    ).resolves.not.toHaveLength(0);
  });

  it("verifies only new Identity Passkey registrations without the active account", () => {
    const hook = createPasskeyAuthentication(createEnv(recordingDatabase([]))).hooks.before[0];
    const verification = (body: Record<string, unknown>) =>
      // SAFETY: The matcher reads only the path and body of the hook context.
      hook?.matcher({ path: "/passkey/verify-registration", body } as HookEndpointContext);

    expect(verification({ response: {}, createSession: true })).toBe(true);
    expect(verification({ response: {}, name: "laptop" })).toBe(false);
  });
});
