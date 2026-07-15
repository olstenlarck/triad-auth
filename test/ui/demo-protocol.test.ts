import { describe, expect, it } from "vite-plus/test";

import {
  authorizationRequest,
  demoResourceFromIssuer,
  inspectOAuthQuery,
  isIdentitySigningKey,
  tokenExchangeRequest,
} from "../../src/scripts/demo-protocol";

describe("Better Auth demo protocol", () => {
  it("builds the identity-only authorization request with the projected client and resource", () => {
    const request = authorizationRequest({
      authorizationEndpoint: "https://auth.example/api/auth/oauth2/authorize",
      callbackUrl: "https://auth.example/demo/callback/",
      challenge: "challenge",
      clientId: "server-client-id",
      resource: "https://auth.example/demo/",
      state: "state",
    });

    expect(request.href).toBe(
      "https://auth.example/api/auth/oauth2/authorize?response_type=code&client_id=server-client-id&redirect_uri=https%3A%2F%2Fauth.example%2Fdemo%2Fcallback%2F&scope=openid&resource=https%3A%2F%2Fauth.example%2Fdemo%2F&state=state&code_challenge=challenge&code_challenge_method=S256",
    );
  });

  it("derives the canonical demo resource from the server issuer", () => {
    expect(demoResourceFromIssuer("https://auth.example/api/auth")).toBe(
      "https://auth.example/demo/",
    );
  });

  it("preserves the exact signed query while inspecting canonical values", () => {
    const rawQuery =
      "?client_id=server-client&scope=openid&resource=https%3A%2F%2Fresource.example%2F&resource=https%3A%2F%2Fsecond.example%2F&exp=1&sig=signed";

    expect(inspectOAuthQuery(rawQuery)).toEqual({
      clientId: "server-client",
      oauthQuery: rawQuery.slice(1),
      resources: ["https://resource.example/", "https://second.example/"],
      scopes: ["openid"],
    });
  });

  it.each([
    "?scope=openid&sig=signed",
    "?client_id=client&scope=openid%20email&sig=signed",
    "?client_id=client&scope=openid&scope=openid&sig=signed",
    "?client_id=client&scope=openid&resource=relative&sig=signed",
  ])("rejects an invalid consent query: %s", (query) => {
    expect(() => inspectOAuthQuery(query)).toThrow("authorization request");
  });

  it("binds token exchange to the projected client, resource, callback, and verifier", () => {
    expect(
      tokenExchangeRequest({
        callbackUrl: "https://auth.example/demo/callback/",
        clientId: "server-client-id",
        code: "code",
        resource: "https://auth.example/demo/",
        verifier: "verifier",
      }).toString(),
    ).toBe(
      "grant_type=authorization_code&client_id=server-client-id&redirect_uri=https%3A%2F%2Fauth.example%2Fdemo%2Fcallback%2F&code=code&code_verifier=verifier&resource=https%3A%2F%2Fauth.example%2Fdemo%2F",
    );
  });

  it.each([
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC", use: "sig" },
  ])("accepts an RC.1 ES256 signing key with optional use: $use", (key) => {
    expect(isIdentitySigningKey(key, "active")).toBe(true);
  });

  it.each([
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC", use: "enc" },
    { alg: "ES384", crv: "P-256", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-384", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "other", kty: "EC" },
    { alg: "ES256", crv: "P-256", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "active", kty: "RSA" },
  ])("rejects an ineligible identity signing key: $key", (key) => {
    expect(isIdentitySigningKey(key, "active")).toBe(false);
  });
});
