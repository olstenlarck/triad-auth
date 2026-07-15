import type { Account, BetterAuthOptions } from "better-auth";
import type { TriadEnv } from "../env";
import { accountSubject, type IdentityProvider, providerSubject } from "./subjects";

const ACCOUNT_SUB_PATTERN = /^acc_[0-9a-f]{64}$/;
const GOOGLE_SUB_PATTERN = /^[\x21-\x7e]{1,255}$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const IDENTITY_PROVIDERS: IdentityProvider[] = ["google", "github", "twitter"];

function invalidUpstreamId(provider: IdentityProvider): Error {
  return new Error(`Invalid ${provider} immutable upstream ID`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function googleUpstreamId(profile: unknown): string {
  const upstreamId = isRecord(profile) ? profile.sub : undefined;
  if (typeof upstreamId !== "string" || !GOOGLE_SUB_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("google");
  }

  return upstreamId;
}

function githubUpstreamId(profile: unknown): string {
  const upstreamId = isRecord(profile) ? profile.id : undefined;
  if (typeof upstreamId === "number" && Number.isSafeInteger(upstreamId) && upstreamId > 0) {
    return String(upstreamId);
  }
  if (typeof upstreamId !== "string" || !DECIMAL_ID_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("github");
  }

  return upstreamId;
}

function twitterUpstreamId(profile: unknown): string {
  const data = isRecord(profile) && isRecord(profile.data) ? profile.data : undefined;
  const upstreamId = data?.id;
  if (typeof upstreamId !== "string" || !DECIMAL_ID_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("twitter");
  }

  return upstreamId;
}

async function mapIdentity(secret: string, provider: IdentityProvider, upstreamId: string) {
  const [providerSub, accountSub] = await Promise.all([
    providerSubject(secret, provider, upstreamId),
    accountSubject(secret, provider, upstreamId),
  ]);

  return {
    id: providerSub,
    email: `${accountSub}@identity.invalid`,
    emailVerified: false,
    provider,
    providerSub,
  };
}

function accountSubFromSyntheticEmail(email: unknown): string {
  if (typeof email !== "string" || !email.endsWith("@identity.invalid")) {
    throw new Error("Triad users require a synthetic identity email");
  }
  const accountSub = email.slice(0, -"@identity.invalid".length);
  if (!ACCOUNT_SUB_PATTERN.test(accountSub)) {
    throw new Error("Triad users require a deterministic account subject");
  }

  return accountSub;
}

function assertProviderIdentity(user: Record<string, unknown>): void {
  const provider = user.provider;
  if (
    typeof provider !== "string" ||
    !IDENTITY_PROVIDERS.includes(provider as IdentityProvider) ||
    typeof user.providerSub !== "string" ||
    !new RegExp(`^pid_${provider}_[0-9a-f]{64}$`).test(user.providerSub)
  ) {
    throw new Error("Triad users require a coherent provider identity");
  }
}

function stripProviderTokens(account: Partial<Account> & Record<string, unknown>) {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

export function createIdentityConfiguration(env: TriadEnv) {
  return {
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        disableDefaultScope: true,
        disableIdTokenSignIn: true,
        includeGrantedScopes: false,
        scope: ["openid"],
        mapProfileToUser: (profile: unknown) =>
          mapIdentity(env.IDENTIFIER_SECRET, "google", googleUpstreamId(profile)),
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        disableDefaultScope: true,
        disableIdTokenSignIn: true,
        scope: [],
        mapProfileToUser: (profile: unknown) =>
          mapIdentity(env.IDENTIFIER_SECRET, "github", githubUpstreamId(profile)),
      },
      twitter: {
        clientId: env.TWITTER_CLIENT_ID,
        clientSecret: env.TWITTER_CLIENT_SECRET,
        disableDefaultScope: true,
        disableIdTokenSignIn: true,
        scope: ["tweet.read", "users.read"],
        mapProfileToUser: (profile: unknown) =>
          mapIdentity(env.IDENTIFIER_SECRET, "twitter", twitterUpstreamId(profile)),
      },
    },
    user: {
      additionalFields: {
        provider: {
          type: "string",
          required: true,
        },
        providerSub: {
          type: "string",
          required: true,
          unique: true,
        },
      },
    },
    account: {
      updateAccountOnSignIn: false,
      storeAccountCookie: false,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, _context) => {
            assertProviderIdentity(user);

            return {
              data: {
                id: accountSubFromSyntheticEmail(user.email),
              },
            };
          },
        },
        update: {
          before: async (user, _context) => {
            if ("provider" in user || "providerSub" in user || "email" in user) {
              return false;
            }
          },
        },
      },
      account: {
        create: {
          before: async (account, _context) => ({ data: stripProviderTokens(account) }),
        },
        update: {
          before: async (account, _context) => ({ data: stripProviderTokens(account) }),
        },
      },
    },
  } satisfies BetterAuthOptions;
}
