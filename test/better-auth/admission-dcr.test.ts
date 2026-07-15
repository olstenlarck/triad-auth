// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import {
  checkOAuthClient,
  type OAuthClient,
  type OAuthOptions,
  type Scope,
} from "@better-auth/oauth-provider";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  createClientAdmissionFragment,
  createPublicDcrOptions,
} from "../../src/better-auth/admission";

const entrySource = readFileSync(
  new URL(import.meta.resolve("@better-auth/oauth-provider")),
  "utf8",
);

describe("public DCR policy", () => {
  it("enables anonymous authorization-code registration with mandatory PKCE", () => {
    const options = createPublicDcrOptions();

    expectTypeOf(options).toMatchTypeOf<Partial<OAuthOptions<Scope[]>>>();

    expect(options).toEqual({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      grantTypes: ["authorization_code"],
    });
    expect(options).not.toHaveProperty("validateInitialAccessToken");
    expect(options).not.toHaveProperty("generateClientId");
  });

  it("allows only authorization_code clients", async () => {
    const options: OAuthOptions<Scope[]> = {
      ...createPublicDcrOptions(),
      consentPage: "/consent/",
      loginPage: "/sign-in/",
    };
    const client: OAuthClient = {
      client_id: "generated-client-id",
      redirect_uris: ["https://client.example.com/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };

    await expect(checkOAuthClient(client, options, { isRegister: true })).resolves.toBeUndefined();
    await expect(
      checkOAuthClient({ ...client, grant_types: ["refresh_token"] }, options, {
        isRegister: true,
      }),
    ).rejects.toMatchObject({
      body: { error: "invalid_client_metadata" },
    });
  });

  it("uses the patched anonymous none guard and never creates a public client secret", () => {
    expect(entrySource).toContain('body.token_endpoint_auth_method !== "none"');
    expect(entrySource).toContain(
      "const clientSecret = isPublic || isPrivateKeyJwt || isExtensionAuthMethod ? void 0",
    );
  });

  it("retains S256-only PKCE and safe exact registered redirect checks", () => {
    expect(entrySource).toContain('code_challenge_methods_supported: ["S256"]');
    expect(entrySource).toContain("redirect_uris: z.array(SafeUrlSchema).min(1).optional()");
    expect(entrySource).toContain("if (url === requested) return true");
    expect(entrySource).toContain("findRegisteredRedirectUri(client.redirectUris, redirectUri)");
  });

  it("does not use Origin as client identity", () => {
    const options = createPublicDcrOptions();

    expect(options).not.toHaveProperty("generateClientId");
    expect(entrySource).toContain(
      "const clientId = opts.generateClientId?.() || generateRandomString",
    );
    expect(entrySource).not.toContain('headers.get("origin")');
  });
});

describe("client admission fragment", () => {
  it("composes CIMD discovery with public DCR options", () => {
    const fragment = createClientAdmissionFragment(
      { AUTH_ORIGIN: "https://auth.example.com" },
      { resolveHostname: async () => ["8.8.8.8"] },
    );

    expect(fragment.oauthProvider.allowDynamicClientRegistration).toBe(true);
    expect(fragment.oauthProvider.allowUnauthenticatedClientRegistration).toBe(true);
    expect(fragment.oauthProvider.clientRegistrationRequirePKCE).toBe(true);
    expect(fragment.oauthProvider.grantTypes).toEqual(["authorization_code"]);
    expect(fragment.oauthProvider.extensions).toHaveLength(1);
    expect(fragment.oauthProvider.extensions[0]?.clientDiscovery).toMatchObject({
      id: "cimd",
      discoveryMetadata: { client_id_metadata_document_supported: true },
    });
  });
});
