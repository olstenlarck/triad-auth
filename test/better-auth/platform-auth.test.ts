import { createAuthEndpoint } from "better-auth/api";
import { env as ambientEnv, type BetterAuthPlugin } from "better-auth";
import { afterEach, describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  AUTH_BASE_PATH,
  createTriadAuth,
  createTriadAuthOptions,
} from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";

const database = {} as D1Database;
const assets = {} as Fetcher;

function createEnv(overrides: Partial<TriadEnv> = {}): TriadEnv {
  return {
    ASSETS: assets,
    DB: database,
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    IDENTIFIER_SECRET: "identifier-secret",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    TWITTER_CLIENT_ID: "twitter-client-id",
    TWITTER_CLIENT_SECRET: "twitter-client-secret",
    ...overrides,
  };
}

const contractPlugin = {
  id: "platform-contract",
  endpoints: {
    platformContract: createAuthEndpoint("/platform-contract", { method: "GET" }, async () => ({
      platform: "triad" as const,
    })),
  },
} satisfies BetterAuthPlugin;

function assertPluginEndpointInference() {
  const auth = createTriadAuth(createEnv(), { plugins: [contractPlugin] });

  expectTypeOf(auth.api.platformContract).toBeFunction();
}

function assertFixedOptionsCannotBeConfigured() {
  const env = createEnv();

  const databaseConfiguration = { database: {} as D1Database };
  // @ts-expect-error The Worker D1 binding cannot be replaced.
  createTriadAuthOptions(env, databaseConfiguration);

  const baseURLConfiguration = { baseURL: "https://attacker.example.com" };
  // @ts-expect-error The canonical origin cannot be replaced.
  createTriadAuthOptions(env, baseURLConfiguration);

  const basePathConfiguration = { basePath: "/attacker" };
  // @ts-expect-error The fixed auth base path cannot be replaced.
  createTriadAuthOptions(env, basePathConfiguration);

  const secretConfiguration = {
    secret: "attacker-secret-that-is-at-least-32-characters",
  };
  // @ts-expect-error The binding-backed secret cannot be replaced.
  createTriadAuthOptions(env, secretConfiguration);

  const secretsConfiguration = {
    secrets: [{ version: 1, value: "alternate-secret" }],
  };
  // @ts-expect-error Alternate secret arrays cannot be configured.
  createTriadAuthOptions(env, secretsConfiguration);

  const trustedOriginsConfiguration = {
    trustedOrigins: ["https://attacker.example.com"],
  };
  // @ts-expect-error Trusted origins cannot be extended or replaced.
  createTriadAuthOptions(env, trustedOriginsConfiguration);

  const emailAndPasswordConfiguration = {
    emailAndPassword: { enabled: true },
  };
  // @ts-expect-error Email and password authentication remains disabled.
  createTriadAuthOptions(env, emailAndPasswordConfiguration);

  const csrfConfiguration = { advanced: { disableCSRFCheck: true } };
  // @ts-expect-error CSRF checks cannot be disabled.
  createTriadAuthOptions(env, csrfConfiguration);

  const originCheckConfiguration = { advanced: { disableOriginCheck: true } };
  // @ts-expect-error Origin checks cannot be disabled.
  createTriadAuthOptions(env, originCheckConfiguration);
}

void assertPluginEndpointInference;
void assertFixedOptionsCannotBeConfigured;

afterEach(() => {
  delete ambientEnv.BETTER_AUTH_SECRETS;
  delete ambientEnv.BETTER_AUTH_TRUSTED_ORIGINS;
});

describe("Triad Better Auth platform options", () => {
  it("uses the exact Worker D1 binding", () => {
    const options = createTriadAuthOptions(createEnv());

    expect(options.database).toBe(database);
  });

  it.each(["https://AUTH.EXAMPLE.com:443", "https://AUTH.EXAMPLE.com:443/"])(
    "normalizes bare canonical origin %s and fixes the auth base path",
    (origin) => {
      const options = createTriadAuthOptions(createEnv({ AUTH_ORIGIN: origin }));

      expect(options.baseURL).toBe("https://auth.example.com");
      expect(options.basePath).toBe(AUTH_BASE_PATH);
      expect(AUTH_BASE_PATH).toBe("/api/auth");
    },
  );

  it("disables password auth and trusts only the canonical origin", () => {
    const options = createTriadAuthOptions(createEnv());

    expect(options.emailAndPassword).toEqual({ enabled: false });
    expect(options.trustedOrigins).toEqual(["https://auth.example.com"]);
    expect(options.advanced.disableCSRFCheck).toBe(false);
    expect(options.advanced.disableOriginCheck).toBe(false);
  });

  it("preserves plugin tuples and non-fixed configuration", () => {
    const options = createTriadAuthOptions(createEnv(), {
      appName: "Triad",
      plugins: [contractPlugin],
      advanced: { cookiePrefix: "triad" },
    });

    expect(options.appName).toBe("Triad");
    expect(options.plugins).toEqual([contractPlugin]);
    expect(options.advanced).toEqual({
      cookiePrefix: "triad",
      disableCSRFCheck: false,
      disableOriginCheck: false,
    });
  });

  it("discards forbidden runtime configuration properties", () => {
    const replacementDatabase = {} as D1Database;
    const forbiddenConfiguration = {
      database: replacementDatabase,
      baseURL: "https://attacker.example.com",
      basePath: "/attacker",
      secret: "attacker-secret-that-is-at-least-32-characters",
      secrets: [{ version: 1, value: "alternate-secret" }],
      trustedOrigins: ["https://attacker.example.com"],
      emailAndPassword: { enabled: true },
      advanced: {
        cookiePrefix: "preserved",
        disableCSRFCheck: true,
        disableOriginCheck: true,
      },
    };
    const options = createTriadAuthOptions(createEnv(), forbiddenConfiguration as never);

    expect(options).toMatchObject({
      database,
      baseURL: "https://auth.example.com",
      basePath: "/api/auth",
      secret: "test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["https://auth.example.com"],
      emailAndPassword: { enabled: false },
      advanced: {
        cookiePrefix: "preserved",
        disableCSRFCheck: false,
        disableOriginCheck: false,
      },
    });
    expect(options.secrets).toBeUndefined();
  });

  it.each(["BETTER_AUTH_SECRETS", "BETTER_AUTH_TRUSTED_ORIGINS"] as const)(
    "rejects a nonempty ambient %s override",
    (name) => {
      ambientEnv[name] = "forbidden-ambient-value";

      expect(() => createTriadAuthOptions(createEnv())).toThrow(name);
    },
  );

  it.each([undefined, "", "short-secret"])(
    "rejects a missing or short Better Auth secret",
    (secret) => {
      const env = createEnv({ BETTER_AUTH_SECRET: secret as string });

      expect(() => createTriadAuthOptions(env)).toThrow("BETTER_AUTH_SECRET");
    },
  );

  it.each([
    "not a URL",
    "ftp://auth.example.com",
    "https://user:password@auth.example.com",
    "https://auth.example.com/path",
    "https://auth.example.com/.",
    "https://auth.example.com/a/..",
    "https://auth.example.com/%2e",
    "https://auth.example.com?query=value",
    "https://auth.example.com#fragment",
    "http://auth.example.com",
  ])("rejects an invalid auth origin: %s", (origin) => {
    expect(() => createTriadAuthOptions(createEnv({ AUTH_ORIGIN: origin }))).toThrow("AUTH_ORIGIN");
  });

  it.each([
    "https://auth.example.com\\.",
    "https://auth.example.com\\a\\..",
    "https://auth.example.com\\%2e",
  ])("rejects a backslash path auth origin: %s", (origin) => {
    expect(() => createTriadAuthOptions(createEnv({ AUTH_ORIGIN: origin }))).toThrow("AUTH_ORIGIN");
  });

  it.each([
    ["http://localhost", "http://localhost"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://127.1.2.3", "http://127.1.2.3"],
    ["http://[::1]:8787", "http://[::1]:8787"],
  ])("allows local HTTP origin %s", (origin, normalizedOrigin) => {
    const options = createTriadAuthOptions(createEnv({ AUTH_ORIGIN: origin }));

    expect(options.baseURL).toBe(normalizedOrigin);
  });

  it("provides the canonical application configuration seam", () => {
    const env = createEnv();
    const configuration = createTriadConfiguration(env);
    const options = createTriadAuthOptions(env, configuration);

    expect(configuration).toEqual({});
    expect(options.database).toBe(env.DB);
  });
});
