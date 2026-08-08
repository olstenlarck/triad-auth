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
    profileClaims: createProfileClaimResolver(env.PROFILE_DATA_KEYRING),
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
        token: { window: 60, max: 20 },
        authorize: { window: 60, max: 30 },
        introspect: { window: 60, max: 60 },
        revoke: { window: 60, max: 30 },
        register: { window: 60, max: 5 },
        userinfo: { window: 60, max: 60 },
      },
      extensions: [...tokenExtensions, ...admissionExtensions],
    }),
    jwt(tokenComposition.jwtOptions),
  ]);

  return {
    ...identityConfiguration,
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/social": { window: 60, max: 10 },
        "/device/code": { window: 60, max: 10 },
        "/device": { window: 60, max: 30 },
        "/device/token": { window: 60, max: 30 },
      },
    },
    plugins,
  } satisfies TriadAuthConfiguration;
}
