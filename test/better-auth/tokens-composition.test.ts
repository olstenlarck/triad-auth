import type {
  OAuthClaimExtensionInput,
  OAuthProviderExtension,
  OAuthUserInfoExtensionInput,
} from "@better-auth/oauth-provider";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { User } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTokenComposition,
  REFRESH_TOKEN_TTL_SECONDS,
  type TokenIdentityResolver,
} from "../../src/better-auth/tokens";

const clientId = "https://client.example/metadata.json";
const resource = "https://wallet.example/mcp";
const user = {
  createdAt: new Date("2026-07-15T00:00:00Z"),
  email: "acc_global@identity.invalid",
  emailVerified: false,
  id: "acc_global",
  name: "Triad account",
  providerSub: "pid_github_global",
  updatedAt: new Date("2026-07-15T00:00:00Z"),
} satisfies User & Record<string, unknown>;

function createIdentityResolver(): TokenIdentityResolver {
  return {
    resolvePairwiseSubject: vi.fn(
      async (accountSub, exactClientId) => `pws:${accountSub}:${exactClientId}`,
    ),
    resolveProviderSubject: vi.fn(async (identity) => String(identity.providerSub)),
  };
}

function createComposition(identity = createIdentityResolver()) {
  return createTokenComposition({
    identity,
    resource: {
      oauthProviderOptions: {
        enforcePerClientResources: true,
        resources: [{ identifier: resource, signingAlgorithm: "ES256" }],
        scopes: ["wallet:read"],
      },
      oauthProviderExtensions: [],
    },
  });
}

function claimsExtension(
  composition: ReturnType<typeof createComposition>,
): OAuthProviderExtension {
  const extension = composition.oauthProviderOptions.extensions?.at(-1);
  if (!extension) {
    throw new Error("Token claims extension is missing");
  }

  return extension;
}

function claimInput(): OAuthClaimExtensionInput {
  return {
    client: { clientId },
    ctx: {} as OAuthClaimExtensionInput["ctx"],
    opts: {} as OAuthClaimExtensionInput["opts"],
    scopes: ["openid", "wallet:read"],
    user,
  };
}

describe("token composition", () => {
  it("sets the access and refresh token lifetimes", () => {
    const { oauthProviderOptions } = createComposition();

    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(oauthProviderOptions.accessTokenExpiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(oauthProviderOptions.refreshTokenExpiresIn).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  it("configures ES256 signing and a public JWKS without session JWT headers", () => {
    const { jwtOptions } = createComposition();

    expect(jwtOptions).toEqual({
      disableSettingJwtHeader: true,
      jwks: { keyPairConfig: { alg: "ES256" } },
    });
  });

  it("composes through the RC.1 OAuth Provider and JWT factories", () => {
    const composition = createComposition();
    const providerPlugin = oauthProvider({
      ...composition.oauthProviderOptions,
      consentPage: "/consent/",
      loginPage: "/sign-in/",
    });
    const jwtPlugin = jwt(composition.jwtOptions);

    expect(providerPlugin.options.resources).toEqual(composition.oauthProviderOptions.resources);
    expect(providerPlugin.options.resolveSubjectIdentifier).toBe(
      composition.oauthProviderOptions.resolveSubjectIdentifier,
    );
    expect(jwtPlugin.options.jwks?.keyPairConfig).toEqual({ alg: "ES256" });
  });

  it("keeps resource policy exact and excludes profile and email scopes", () => {
    const { oauthProviderOptions } = createComposition();

    expect(oauthProviderOptions.resources).toEqual([
      { identifier: resource, signingAlgorithm: "ES256" },
    ]);
    expect(oauthProviderOptions.enforcePerClientResources).toBe(true);
    expect(oauthProviderOptions.scopes).toEqual(["openid", "offline_access", "wallet:read"]);
    expect(oauthProviderOptions.scopes).not.toContain("profile");
    expect(oauthProviderOptions.scopes).not.toContain("email");
  });

  it.each(["profile", "email"])("rejects the synthetic %s scope", (scope) => {
    expect(() =>
      createTokenComposition({
        identity: createIdentityResolver(),
        resource: {
          oauthProviderOptions: { resources: [resource], scopes: [scope] },
          oauthProviderExtensions: [],
        },
      }),
    ).toThrow(`Token resources must not request the ${scope} scope`);
  });

  it("preserves resource extensions before token claim composition", () => {
    const resourceExtension: OAuthProviderExtension = {
      metadata: () => ({ resource_metadata: resource }),
    };
    const composition = createTokenComposition({
      identity: createIdentityResolver(),
      resource: {
        oauthProviderOptions: { resources: [resource], scopes: ["wallet:read"] },
        oauthProviderExtensions: [resourceExtension],
      },
    });

    expect(composition.oauthProviderOptions.extensions?.[0]).toBe(resourceExtension);
    expect(composition.oauthProviderOptions.extensions).toHaveLength(2);
  });

  it("requires at least one exact resource audience", () => {
    expect(() =>
      createTokenComposition({
        identity: createIdentityResolver(),
        resource: {
          oauthProviderOptions: { scopes: ["wallet:read"] },
          oauthProviderExtensions: [],
        },
      }),
    ).toThrow("Token composition requires at least one OAuth resource");
  });

  it("derives the OIDC subject from the exact client ID", async () => {
    const identity = createIdentityResolver();
    const { oauthProviderOptions } = createComposition(identity);

    const subject = await oauthProviderOptions.resolveSubjectIdentifier?.({
      clientId,
      defaultSubject: "package-default",
      subjectType: "pairwise",
      use: "id_token",
      userId: user.id,
    });

    expect(subject).toBe(`pws:${user.id}:${clientId}`);
    expect(identity.resolvePairwiseSubject).toHaveBeenCalledWith(user.id, clientId);
  });

  it("adds triple identity claims to ID tokens", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);

    await expect(extension.claims?.idToken?.(claimInput())).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
  });

  it("adds global-subject triple claims to access tokens and introspection", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);

    const claims = await extension.claims?.accessToken?.(claimInput());

    expect(claims).toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
    expect(claims).not.toHaveProperty("sub");
    expect(claims).not.toHaveProperty("client_id");
    expect(claims).not.toHaveProperty("aud");
  });

  it("adds the same pairwise subject and triple claims to UserInfo", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);
    const input: OAuthUserInfoExtensionInput = {
      client: { clientId },
      ctx: {} as OAuthUserInfoExtensionInput["ctx"],
      jwt: { client_id: clientId, sub: user.id },
      opts: {} as OAuthUserInfoExtensionInput["opts"],
      requestedClaims: [],
      scopes: ["openid"],
      user,
    };

    await expect(extension.claims?.userInfo?.(input)).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
  });

  it("advertises only subject identity claims", () => {
    const { oauthProviderOptions } = createComposition();

    expect(oauthProviderOptions.advertisedMetadata?.claims_supported).toEqual([
      "sub",
      "pairwise_sub",
      "account_sub",
      "provider_sub",
    ]);
  });
});
