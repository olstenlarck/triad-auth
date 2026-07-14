import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import { identityClaims, profileClaims, TRIAD_CLAIMS, TRIAD_SCOPES } from "./claims";
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

    const data =
      profile.data && typeof profile.data === "object"
        ? (profile.data as Record<string, unknown>)
        : undefined;

    const providerName = text(profile.name) ?? text(data?.name);
    const providerHandle = text(profile.login) ?? text(data?.username);
    const providerAvatar =
      text(profile.picture) ?? text(profile.avatar_url) ?? text(data?.profile_image_url);

    return {
      // Better Auth uses this value as account.accountId and for account lookup.
      id: principal.providerSub,
      // The user create hook below makes this the actual user primary key.
      accountSub: principal.accountSub,
      provider,
      providerSub: principal.providerSub,
      providerName,
      providerHandle,
      providerAvatar,
      name: providerName ?? providerHandle ?? principal.accountSub,
      // Better Auth's core email remains internal so equal provider emails never
      // merge identities. The actual provider email is stored separately and only
      // emitted to downstream clients that request the email scope.
      email: `${principal.accountSub}@users.triad.invalid`,
      providerEmail: text(profile.email) ?? text(data?.email),
      image: providerAvatar,
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
        providerEmail: { type: "string", required: false, input: true, returned: false },
        providerName: { type: "string", required: false, input: true, returned: false },
        providerHandle: { type: "string", required: false, input: true, returned: false },
        providerAvatar: { type: "string", required: false, input: true, returned: false },
        providerEmailVerified: {
          type: "boolean",
          required: true,
          input: false,
          returned: false,
        },
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
                // emailVerified belongs to the hidden provider email; the internal
                // synthetic core email is deliberately never treated as verified.
                providerEmailVerified: Boolean(user.providerEmail && user.emailVerified),
                emailVerified: false,
              },
            };
          },
        },
      },
    },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: [...TRIAD_SCOPES],
        advertisedMetadata: {
          scopes_supported: [...TRIAD_SCOPES],
          claims_supported: [...TRIAD_CLAIMS],
        },
        // Keeps pairwise client handling enabled throughout Better Auth. The
        // resolver below takes precedence over Better Auth's built-in formula.
        pairwiseSecret: env.TRIAD_ROOT_SECRET,
        resolveSubjectIdentifier: ({ userId, clientId }) =>
          pairwiseSubject(env.TRIAD_ROOT_SECRET, userId, clientId),
        customIdTokenClaims: async ({ user, scopes, subject }) => {
          const triadUser = user as unknown as Record<string, unknown>;
          return {
            ...identityClaims(triadUser, subject),
            ...profileClaims(triadUser, scopes),
          };
        },
        customAccessTokenClaims: async ({ user, scopes, subject }) => {
          if (!user || !subject) return {};
          const triadUser = user as unknown as Record<string, unknown>;
          return {
            ...identityClaims(triadUser, subject),
            ...profileClaims(triadUser, scopes),
          };
        },
        customUserInfoClaims: async ({ user, scopes, subject, requestedClaims }) => {
          const triadUser = user as unknown as Record<string, unknown>;
          return {
            ...identityClaims(triadUser, subject),
            ...profileClaims(triadUser, scopes, requestedClaims, true),
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
