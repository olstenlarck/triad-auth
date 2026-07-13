import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { deviceAuthorization } from "better-auth/plugins";
import type { Env } from "./env";
import {
  derivePrincipal,
  pairwiseSubject,
  providerSubject,
  type TriadProvider,
} from "./ids";

type UnknownProfile = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function upstreamId(profile: UnknownProfile): string {
  const data =
    profile.data && typeof profile.data === "object"
      ? (profile.data as Record<string, unknown>)
      : undefined;
  const value = profile.sub ?? profile.id ?? data?.id;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("upstream identity provider returned no stable subject");
  }
  return String(value);
}

function providerProfile(env: Env, provider: TriadProvider) {
  return async (profile: UnknownProfile) => {
    const principal = await derivePrincipal(env.TRIAD_ROOT_SECRET, provider, upstreamId(profile));
    return {
      id: principal.accountSub,
      provider: provider,
      providerSub: principal.providerSub,
      name:
        text(profile.name) ??
        text(profile.login) ??
        text((profile.data as Record<string, unknown> | undefined)?.username) ??
        principal.accountSub,
      email: text(profile.email) ?? `${principal.accountSub}@invalid.triad.local`,
      emailVerified: Boolean(profile.email_verified),
      image: text(profile.picture) ?? text(profile.avatar_url),
    };
  };
}

function socialProviders(env: Env) {
  return {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            mapProfileToUser: providerProfile(env, "google"),
          },
        }
      : {}),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            mapProfileToUser: providerProfile(env, "github"),
          },
        }
      : {}),
    ...(env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET
      ? {
          twitter: {
            clientId: env.TWITTER_CLIENT_ID,
            clientSecret: env.TWITTER_CLIENT_SECRET,
            mapProfileToUser: providerProfile(env, "twitter"),
          },
        }
      : {}),
  };
}

function clientIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  return (
    text(metadata.client_id) ??
    text(metadata.clientId) ??
    text(metadata.triadClientId) ??
    text(metadata.cimdDocumentUrl)
  );
}

async function triadClaims(
  env: Env,
  user: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) {
  const accountSub = String(user.id);
  const clientId = clientIdFromMetadata(metadata);
  return {
    account_sub: accountSub,
    provider_sub: text(user.providerSub),
    ...(clientId
      ? { pairwise_sub: await pairwiseSubject(env.TRIAD_ROOT_SECRET, accountSub, clientId) }
      : {}),
  };
}

export function createAuth(env: Env) {
  return betterAuth({
    appName: "Triad Auth",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    socialProviders: socialProviders(env),
    user: {
      additionalFields: {
        provider: { type: "string", required: true, input: false },
        providerSub: { type: "string", required: true, input: false },
      },
    },
    account: {
      accountLinking: {
        enabled: false,
        trustedProviders: [],
      },
      storeAccountCookie: false,
    },
    databaseHooks: {
      account: {
        create: {
          before: async account => {
            const provider = account.providerId as TriadProvider;
            if (!["google", "github", "twitter"].includes(provider)) return;
            return {
              data: {
                ...account,
                accountId: await providerSubject(
                  env.TRIAD_ROOT_SECRET,
                  provider,
                  String(account.accountId),
                ),
                accessToken: undefined,
                refreshToken: undefined,
                idToken: undefined,
              },
            };
          },
        },
      },
    },
    plugins: [
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: ["openid", "email", "profile"],
        customIdTokenClaims: async ({ user, metadata }) =>
          triadClaims(
            env,
            user as unknown as Record<string, unknown>,
            metadata as Record<string, unknown> | undefined,
          ),
        customUserInfoClaims: async ({ user, metadata }) =>
          triadClaims(
            env,
            user as unknown as Record<string, unknown>,
            metadata as Record<string, unknown> | undefined,
          ),
      }),
      cimd({
        refreshRate: "60m",
        allowFetch: async url => {
          const parsed = new URL(url);
          return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
        },
      }),
      deviceAuthorization({
        expiresIn: "15m",
        interval: "5s",
      }),
    ],
  });
}

export type TriadAuth = ReturnType<typeof createAuth>;
