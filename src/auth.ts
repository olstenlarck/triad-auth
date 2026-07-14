import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { deviceAuthorization } from "better-auth/plugins";
import type { Env } from "./env";
import { derivePrincipal, pairwiseSubject, type TriadProvider } from "./ids";

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
      // Better Auth uses this value as account.accountId and for account lookup.
      id: principal.providerSub,
      // The user create hook below makes this the actual user primary key.
      accountSub: principal.accountSub,
      provider,
      providerSub: principal.providerSub,
      name:
        text(profile.name) ??
        text(profile.login) ??
        text((profile.data as Record<string, unknown> | undefined)?.username) ??
        principal.accountSub,
      // Better Auth currently requires an email. Never use an upstream email for
      // identity lookup: equal emails across providers must remain separate users.
      email: `${principal.accountSub}@users.triad.invalid`,
      emailVerified: false,
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

function triadIdentityClaims(user: Record<string, unknown>) {
  return {
    account_sub: String(user.id),
    provider_sub: text(user.providerSub),
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
        // These are supplied only by the server-side provider mapper. Better Auth
        // requires input:true for mapped OAuth profile fields to reach creation.
        accountSub: { type: "string", required: true, input: true, returned: false },
        provider: { type: "string", required: true, input: true, returned: false },
        providerSub: { type: "string", required: true, input: true, returned: false },
      },
    },
    account: {
      accountLinking: {
        enabled: false,
        trustedProviders: [],
      },
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const accountSub = text(user.accountSub);
            if (!accountSub?.startsWith("acc_")) {
              throw new Error("OAuth user is missing a valid Triad account_sub");
            }
            return {
              data: {
                ...user,
                // Triad's global account identifier is Better Auth's user key.
                id: accountSub,
              },
            };
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              // accountId is already provider_sub because mapProfileToUser.id was
              // replaced before Better Auth performed its account lookup.
              accessToken: undefined,
              refreshToken: undefined,
              idToken: undefined,
            },
          }),
        },
      },
    },
    plugins: [
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: ["openid"],
        // Keeps pairwise client handling enabled throughout Better Auth. The
        // resolver below takes precedence over Better Auth's built-in formula.
        pairwiseSecret: env.TRIAD_ROOT_SECRET,
        resolveSubjectIdentifier: ({ userId, clientId }) =>
          pairwiseSubject(env.TRIAD_ROOT_SECRET, userId, clientId),
        customIdTokenClaims: async ({ user }) =>
          triadIdentityClaims(user as unknown as Record<string, unknown>),
        customAccessTokenClaims: async ({ user }) =>
          user ? triadIdentityClaims(user as unknown as Record<string, unknown>) : {},
        customUserInfoClaims: async ({ user, jwt }) => {
          const clientId =
            typeof jwt.client_id === "string"
              ? jwt.client_id
              : typeof jwt.azp === "string"
                ? jwt.azp
                : undefined;
          return {
            ...triadIdentityClaims(user as unknown as Record<string, unknown>),
            ...(clientId
              ? {
                  pairwise_sub: await pairwiseSubject(
                    env.TRIAD_ROOT_SECRET,
                    String(user.id),
                    clientId,
                  ),
                }
              : {}),
          };
        },
      }),
      cimd({
        refreshRate: "60m",
        allowFetch: async (url) => {
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
