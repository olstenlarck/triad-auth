import type {
  OAuthClaimExtensionInput,
  OAuthOptions,
  OAuthProviderExtension,
  OAuthUserInfoExtensionInput,
  Scope,
} from "@better-auth/oauth-provider";
import type { JwtOptions } from "better-auth/plugins";

export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenIdentityUser {
  id: string;
  [key: string]: unknown;
}

export interface TokenIdentityResolver {
  resolvePairwiseSubject(accountSub: string, clientId: string): string | Promise<string>;
  resolveProviderSubject(user: TokenIdentityUser): string | Promise<string>;
}

type OAuthResourceOptionName =
  | "accessTokenExpiresIn"
  | "cachedResources"
  | "enforcePerClientResources"
  | "identifierValidator"
  | "refreshTokenExpiresIn"
  | "resourcePrivileges"
  | "resources"
  | "resourceSeedMode"
  | "scopes";

export type TokenResourceOptions = Pick<OAuthOptions<Scope[]>, OAuthResourceOptionName>;

export interface TokenResourceFragment {
  oauthProviderOptions: TokenResourceOptions;
  oauthProviderExtensions: readonly OAuthProviderExtension[];
}

export interface TokenCompositionDependencies {
  identity: TokenIdentityResolver;
  resource: TokenResourceFragment;
}

interface TripleIdentityClaims extends Record<string, unknown> {
  account_sub: string;
  pairwise_sub: string;
  provider_sub: string;
}

async function resolveTripleIdentityClaims(
  identity: TokenIdentityResolver,
  user: TokenIdentityUser,
  clientId: string,
): Promise<TripleIdentityClaims> {
  const accountSub = user.id;
  const [pairwiseSub, providerSub] = await Promise.all([
    identity.resolvePairwiseSubject(accountSub, clientId),
    identity.resolveProviderSubject(user),
  ]);

  return {
    account_sub: accountSub,
    pairwise_sub: pairwiseSub,
    provider_sub: providerSub,
  };
}

function userInfoClientId(input: OAuthUserInfoExtensionInput): string {
  const tokenClientId =
    typeof input.jwt.client_id === "string"
      ? input.jwt.client_id
      : typeof input.jwt.azp === "string"
        ? input.jwt.azp
        : undefined;
  const clientId = input.client?.clientId ?? tokenClientId;
  if (!clientId) {
    throw new Error("UserInfo identity claims require an exact client ID");
  }

  return clientId;
}

function createIdentityClaimsExtension(identity: TokenIdentityResolver): OAuthProviderExtension {
  return {
    claims: {
      accessToken: (input: OAuthClaimExtensionInput) =>
        input.user ? resolveTripleIdentityClaims(identity, input.user, input.client.clientId) : {},
      idToken: (input: OAuthClaimExtensionInput) =>
        input.user ? resolveTripleIdentityClaims(identity, input.user, input.client.clientId) : {},
      userInfo: (input: OAuthUserInfoExtensionInput) =>
        resolveTripleIdentityClaims(identity, input.user, userInfoClientId(input)),
    },
  };
}

function tokenScopes(resourceScopes: readonly Scope[]): Scope[] {
  for (const scope of resourceScopes) {
    if (scope === "profile" || scope === "email") {
      throw new Error(`Token resources must not request the ${scope} scope`);
    }
  }

  return [...new Set<Scope>(["openid", "offline_access", ...resourceScopes])];
}

export function createTokenComposition({ identity, resource }: TokenCompositionDependencies) {
  const resolveSubjectIdentifier: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
    identity.resolvePairwiseSubject(input.userId, input.clientId);
  const claimsExtension = createIdentityClaimsExtension(identity);
  const {
    resources,
    scopes: resourceScopes = [],
    ...resourceOptions
  } = resource.oauthProviderOptions;
  if (!resources?.length) {
    throw new Error("Token composition requires at least one OAuth resource");
  }

  const oauthProviderOptions = {
    ...resourceOptions,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    resources,
    scopes: tokenScopes(resourceScopes),
    resolveSubjectIdentifier,
    extensions: [...resource.oauthProviderExtensions, claimsExtension],
    advertisedMetadata: {
      claims_supported: ["sub", "pairwise_sub", "account_sub", "provider_sub"],
    },
  } satisfies Partial<OAuthOptions<Scope[]>>;
  const jwtOptions = {
    disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: "ES256" } },
  } satisfies JwtOptions;

  return { oauthProviderOptions, jwtOptions };
}

export type TokenComposition = ReturnType<typeof createTokenComposition>;
