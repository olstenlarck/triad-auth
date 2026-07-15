import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTriadResourceFragment,
  REFRESH_TOKEN_TTL_SECONDS,
  resolveTriadResourceRequest,
  type TriadResourceRequestError,
} from "../../src/better-auth/resources";

const productionEnv = { AUTH_ORIGIN: "https://auth.example.com" };

describe("Triad OAuth resource fragment", () => {
  it("always configures the canonical Triad demo resource", () => {
    const fragment = createTriadResourceFragment(productionEnv);

    expect(fragment.oauthProviderOptions).toEqual({
      accessTokenExpiresIn: 300,
      enforcePerClientResources: false,
      refreshTokenExpiresIn: 2_592_000,
      resourceSeedMode: "overwrite",
      resources: [
        {
          accessTokenTtl: 300,
          allowedScopes: ["openid"],
          disabled: false,
          identifier: "https://auth.example.com/demo/",
          name: "Triad demo",
        },
      ],
      scopes: ["openid"],
    });
    expect(fragment.oauthProviderOptions.resources?.[0]).not.toHaveProperty("refreshTokenTtl");
    expect(fragment.oauthProviderExtensions).toEqual([]);
    expect(fragment.betterAuthPlugins).toEqual([]);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("adds RPC Wallets only when its resource identifier is supplied", () => {
    const fragment = createTriadResourceFragment(productionEnv, {
      rpcWalletsResource: "https://wallets.example.com/mcp",
    });

    expect(fragment.oauthProviderOptions.scopes).toEqual([
      "openid",
      "wallets:read",
      "offline_access",
    ]);
    expect(fragment.oauthProviderOptions.resources).toEqual([
      expect.objectContaining({
        identifier: "https://auth.example.com/demo/",
        allowedScopes: ["openid"],
      }),
      {
        accessTokenTtl: 300,
        allowedScopes: ["wallets:read", "offline_access"],
        disabled: false,
        identifier: "https://wallets.example.com/mcp",
        name: "RPC Wallets",
      },
    ]);
    expect(fragment.oauthProviderOptions.resources?.[1]).not.toHaveProperty("refreshTokenTtl");
  });

  it("uses the installed OAuth Provider public option types", () => {
    const fragment = createTriadResourceFragment(productionEnv);

    expectTypeOf(fragment.oauthProviderOptions.resources).toMatchTypeOf<
      | Array<
          | string
          | {
              identifier: string;
              allowedScopes?: string[];
              accessTokenTtl?: number;
            }
        >
      | undefined
    >();
  });
});

describe("Triad OAuth resource request semantics", () => {
  const fragment = createTriadResourceFragment(productionEnv, {
    rpcWalletsResource: "https://wallets.example.com/mcp",
  });

  it.each<[resource: string | string[] | undefined, description: string]>([
    [undefined, "a missing resource"],
    [[], "an empty resource list"],
    [["https://auth.example.com/demo/", "https://wallets.example.com/mcp"], "multiple resources"],
    [["https://auth.example.com/demo/", "https://auth.example.com/demo/"], "a duplicate"],
    ["https://unknown.example.com", "an unrecognized resource"],
  ])("rejects %s with invalid_target (%s)", (resource) => {
    expect(() => resolveTriadResourceRequest(fragment, { resource, scopes: ["openid"] })).toThrow(
      expect.objectContaining({
        code: "invalid_target",
      } satisfies Partial<TriadResourceRequestError>),
    );
  });

  it.each([
    ["https://auth.example.com/demo/", []],
    ["https://auth.example.com/demo/", ["openid", "offline_access"]],
    ["https://wallets.example.com/mcp", ["openid"]],
    ["https://wallets.example.com/mcp", ["offline_access"]],
    ["https://wallets.example.com/mcp", ["wallets:read", "profile"]],
  ])("rejects noncanonical scopes for %s", (resource, scopes) => {
    expect(() => resolveTriadResourceRequest(fragment, { resource, scopes })).toThrow(
      expect.objectContaining({
        code: "invalid_scope",
      } satisfies Partial<TriadResourceRequestError>),
    );
  });

  it("resolves the demo to its resource and OIDC UserInfo audiences", () => {
    const resolved = resolveTriadResourceRequest(fragment, {
      resource: "https://auth.example.com/demo/",
      scopes: ["openid"],
    });

    expect(resolved).toEqual({
      audience: [
        "https://auth.example.com/demo/",
        "https://auth.example.com/api/auth/oauth2/userinfo",
      ],
      issueRefreshToken: false,
      resource: "https://auth.example.com/demo/",
      resources: ["https://auth.example.com/demo/"],
      scopes: ["openid"],
    });
  });

  it.each([
    [["wallets:read"], false],
    [["offline_access", "wallets:read"], true],
  ] as const)("canonicalizes RPC Wallets scopes %s", (scopes, issueRefreshToken) => {
    const resolved = resolveTriadResourceRequest(fragment, {
      resource: ["https://wallets.example.com/mcp"],
      scopes,
    });

    expect(resolved).toEqual({
      audience: "https://wallets.example.com/mcp",
      issueRefreshToken,
      resource: "https://wallets.example.com/mcp",
      resources: ["https://wallets.example.com/mcp"],
      scopes: issueRefreshToken ? ["wallets:read", "offline_access"] : ["wallets:read"],
    });
  });
});

describe("Triad RFC 9728 protected-resource metadata", () => {
  it("describes each HTTPS resource at its path-preserving well-known URL", () => {
    const fragment = createTriadResourceFragment(productionEnv, {
      rpcWalletsResource: "https://wallets.example.com/mcp",
    });

    expect(fragment.protectedResourceMetadata).toEqual([
      {
        metadataUrl: "https://auth.example.com/.well-known/oauth-protected-resource/demo/",
        document: {
          authorization_servers: ["https://auth.example.com/api/auth"],
          bearer_methods_supported: ["header"],
          resource: "https://auth.example.com/demo/",
          resource_name: "Triad demo",
          scopes_supported: ["openid"],
        },
      },
      {
        metadataUrl: "https://wallets.example.com/.well-known/oauth-protected-resource/mcp",
        document: {
          authorization_servers: ["https://auth.example.com/api/auth"],
          bearer_methods_supported: ["header"],
          resource: "https://wallets.example.com/mcp",
          resource_name: "RPC Wallets",
          scopes_supported: ["wallets:read", "offline_access"],
        },
      },
    ]);
  });

  it("does not publish RFC 9728 metadata for local HTTP or non-HTTPS resources", () => {
    const fragment = createTriadResourceFragment(
      { AUTH_ORIGIN: "http://localhost:8787" },
      { rpcWalletsResource: "urn:rpc-wallets" },
    );

    expect(fragment.protectedResourceMetadata).toEqual([]);
  });
});
