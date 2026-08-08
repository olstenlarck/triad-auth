import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";

import { createClientAdmissionFragment } from "./admission";
import type { TriadAuthConfiguration } from "./auth";
import { createTriadDeviceAuthorization } from "./device";
import type { TriadEnv } from "./env";
import {
  createIdentityConfiguration,
  createProfileClaimResolver,
  pairwiseSubject,
} from "./identity";
import { createD1RateLimitStorage, RATE_LIMIT_WINDOW_SECONDS } from "./rate-limit";
import { createTriadResourceFragment } from "./resources";
import { createTokenComposition, type TokenIdentityUser } from "./tokens";

function providerSubjectFromUser(user: TokenIdentityUser): string {
  if (typeof user.providerSub !== "string") {
    throw new Error("Token identity requires a provider subject");
  }

  return user.providerSub;
}

function preservePluginTuple<const Plugins extends BetterAuthPlugin[]>(plugins: Plugins): Plugins {
  return plugins;
}

export function createTriadConfiguration(env: TriadEnv) {
  const identityConfiguration = createIdentityConfiguration(env);
  const resourceFragment = createTriadResourceFragment(env);
  const admissionFragment = createClientAdmissionFragment(env);
  const tokenComposition = createTokenComposition({
    identity: {
      resolvePairwiseSubject: (accountSub, clientId) =>
        pairwiseSubject(env.IDENTIFIER_SECRET, accountSub, clientId),
      resolveProviderSubject: providerSubjectFromUser,
    },
    profileClaims: createProfileClaimResolver(env.PROFILE_DATA_SECRETS),
    resource: resourceFragment,
  });
  const { extensions: admissionExtensions, ...admissionOptions } = admissionFragment.oauthProvider;
  const { extensions: tokenExtensions, ...tokenOptions } = tokenComposition.oauthProviderOptions;
  const plugins = preservePluginTuple([
    ...resourceFragment.betterAuthPlugins,
    createTriadDeviceAuthorization(env.AUTH_ORIGIN),
    oauthProvider({
      ...tokenOptions,
      ...admissionOptions,
      consentPage: "/consent",
      loginPage: "/me",
      pairwiseSecret: env.IDENTIFIER_SECRET,
      rateLimit: {
        token: { window: RATE_LIMIT_WINDOW_SECONDS, max: 20 },
        authorize: { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        introspect: { window: RATE_LIMIT_WINDOW_SECONDS, max: 60 },
        revoke: { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        register: { window: RATE_LIMIT_WINDOW_SECONDS, max: 5 },
        userinfo: { window: RATE_LIMIT_WINDOW_SECONDS, max: 60 },
      },
      extensions: [...tokenExtensions, ...admissionExtensions],
    }),
    jwt(tokenComposition.jwtOptions),
  ]);

  return {
    ...identityConfiguration,
    rateLimit: {
      enabled: true,
      customStorage: createD1RateLimitStorage(env.DB, env.RATE_LIMIT_SECRET),
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: 60,
      customRules: {
        "/sign-in/social": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/device/code": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/device": { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        "/device/token": { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
      },
    },
    plugins,
  } satisfies TriadAuthConfiguration;
}
