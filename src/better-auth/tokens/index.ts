import type {
  OAuthClaimExtensionInput,
  OAuthOptions,
  OAuthProviderExtension,
  OAuthUserInfoExtensionInput,
  Scope,
} from "@better-auth/oauth-provider";
import type { JwtOptions } from "better-auth/plugins";

import {
  DISCLOSURE_CLAIMS,
  DISCLOSURE_SCOPES,
  PROFILE_DISCLOSURE_SCOPES,
  type ProfileDisclosureClaim,
  type ProfileDisclosureScope,
} from "../disclosures";

export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const ID_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenIdentityUser {
  id: string;
  [key: string]: unknown;
}

export interface TokenIdentityResolver {
  resolvePairwiseSubject(accountSub: string, clientId: string): string | Promise<string>;
  resolveProviderSubject(user: TokenIdentityUser): string | Promise<string>;
}

export interface TokenProfileClaims {
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  picture?: string;
}

export interface TokenProfileClaimResolver {
  resolveProfileClaims(
    user: TokenIdentityUser,
    scopes: readonly ProfileDisclosureScope[],
  ): TokenProfileClaims | Promise<TokenProfileClaims>;
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
  profileClaims?: TokenProfileClaimResolver;
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

function requestedProfileScopes(scopes: readonly string[]): ProfileDisclosureScope[] {
  return PROFILE_DISCLOSURE_SCOPES.filter((scope) => scopes.includes(scope));
}

function assignProfileClaim(
  claims: TokenProfileClaims,
  claim: ProfileDisclosureClaim,
  value: unknown,
): void {
  if (value === undefined) {
    throw new Error(`Token profile resolver did not return the required ${claim} claim`);
  }
  const valid = claim === "email_verified" ? typeof value === "boolean" : typeof value === "string";
  if (!valid) {
    throw new Error(`Token profile resolver returned an invalid ${claim} claim`);
  }

  Object.assign(claims, { [claim]: value });
}

async function resolveScopedProfileClaims(
  resolver: TokenProfileClaimResolver | undefined,
  user: TokenIdentityUser,
  scopes: readonly string[],
): Promise<TokenProfileClaims> {
  const requestedScopes = requestedProfileScopes(scopes);
  if (requestedScopes.length === 0) {
    return {};
  }
  if (!resolver) {
    throw new Error("Token profile scopes require a profile claim resolver");
  }

  const resolved = await resolver.resolveProfileClaims(user, requestedScopes);
  const claims: TokenProfileClaims = {};

  for (const scope of requestedScopes) {
    for (const claim of DISCLOSURE_CLAIMS[scope]) {
      assignProfileClaim(claims, claim, resolved[claim]);
    }
  }

  return claims;
}

async function resolveTokenIdentityClaims(
  identity: TokenIdentityResolver,
  profileClaims: TokenProfileClaimResolver | undefined,
  user: TokenIdentityUser,
  clientId: string,
  scopes: readonly string[],
): Promise<TripleIdentityClaims & TokenProfileClaims> {
  const [identityClaims, scopedProfileClaims] = await Promise.all([
    resolveTripleIdentityClaims(identity, user, clientId),
    resolveScopedProfileClaims(profileClaims, user, scopes),
  ]);

  return { ...identityClaims, ...scopedProfileClaims };
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

function createIdentityClaimsExtension(
  identity: TokenIdentityResolver,
  profileClaims: TokenProfileClaimResolver | undefined,
): OAuthProviderExtension {
  return {
    claims: {
      accessToken: (input: OAuthClaimExtensionInput) =>
        input.user
          ? resolveTokenIdentityClaims(
              identity,
              profileClaims,
              input.user,
              input.client.clientId,
              input.scopes,
            )
          : {},
      idToken: (input: OAuthClaimExtensionInput) =>
        input.user ? resolveTripleIdentityClaims(identity, input.user, input.client.clientId) : {},
      userInfo: (input: OAuthUserInfoExtensionInput) =>
        resolveTripleIdentityClaims(identity, input.user, userInfoClientId(input)),
    },
  };
}

function tokenScopes(resourceScopes: readonly Scope[]): Scope[] {
  for (const scope of resourceScopes) {
    if (scope === "profile") {
      throw new Error(`Token resources must not request the ${scope} scope`);
    }
  }

  return [...new Set<Scope>([...DISCLOSURE_SCOPES, ...resourceScopes])];
}

export function createTokenComposition({
  identity,
  profileClaims,
  resource,
}: TokenCompositionDependencies) {
  const resolveSubjectIdentifier: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
    identity.resolvePairwiseSubject(input.userId, input.clientId);
  const claimsExtension = createIdentityClaimsExtension(identity, profileClaims);
  const {
    resources,
    scopes: resourceScopes = [],
    ...resourceOptions
  } = resource.oauthProviderOptions;
  if (!resources?.length) {
    throw new Error("Token composition requires at least one OAuth resource");
  }
  const scopes = tokenScopes(resourceScopes);

  const oauthProviderOptions = {
    ...resourceOptions,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    idTokenExpiresIn: ID_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    resources,
    scopes,
    clientRegistrationAllowedScopes: scopes,
    clientRegistrationDefaultScopes: ["openid"],
    resolveSubjectIdentifier,
    customIdTokenClaims: (input) =>
      resolveScopedProfileClaims(profileClaims, input.user, input.scopes),
    customUserInfoClaims: (input) =>
      resolveScopedProfileClaims(profileClaims, input.user, input.scopes),
    extensions: [...resource.oauthProviderExtensions, claimsExtension],
    advertisedMetadata: {
      scopes_supported: scopes,
      claims_supported: [
        "sub",
        "pairwise_sub",
        "account_sub",
        "provider_sub",
        "email",
        "email_verified",
        "preferred_username",
        "name",
        "picture",
      ],
    },
  } satisfies Partial<OAuthOptions<Scope[]>>;
  const jwtOptions = {
    disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: "ES256" } },
  } satisfies JwtOptions;

  return { oauthProviderOptions, jwtOptions };
}

export type TokenComposition = ReturnType<typeof createTokenComposition>;
