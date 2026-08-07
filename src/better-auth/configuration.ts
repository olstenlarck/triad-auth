import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";

import { createClientAdmissionFragment } from "./admission";
import type { TriadAuthConfiguration } from "./auth";
import { createTriadDeviceAuthorization } from "./device";
import type { TriadEnv } from "./env";
import { createIdentityConfiguration, pairwiseSubject, profileClaimResolver } from "./identity";
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
  const resourceFragment = createTriadResourceFragment(env, {
    rpcWalletsResource: env.RPC_WALLETS_RESOURCE,
  });
  const admissionFragment = createClientAdmissionFragment(env);
  const tokenComposition = createTokenComposition({
    identity: {
      resolvePairwiseSubject: (accountSub, clientId) =>
        pairwiseSubject(env.IDENTIFIER_SECRET, accountSub, clientId),
      resolveProviderSubject: providerSubjectFromUser,
    },
    profileClaims: profileClaimResolver,
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
      consentPage: "/consent/",
      loginPage: "/me/",
      extensions: [...tokenExtensions, ...admissionExtensions],
    }),
    jwt(tokenComposition.jwtOptions),
  ]);

  return {
    ...identityConfiguration,
    plugins,
  } satisfies TriadAuthConfiguration;
}
