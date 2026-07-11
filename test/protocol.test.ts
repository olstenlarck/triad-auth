import { describe, expect, it } from "vite-plus/test";
import { validateClient } from "../src/db";
import { parseScope, validatePkceChallenge, validatePkceVerifier } from "../src/protocol";
import type { ClientRow, ProviderName } from "../src/types";

const client = (
  redirectUris = '["https://app.example/callback"]',
  providers = '["github"]',
): ClientRow => ({
  client_id: "client_a",
  name: "Example",
  redirect_uris: redirectUris,
  providers,
});

describe("protocol validation", () => {
  it("accepts only RFC 7636-sized URL-safe PKCE values", () => {
    expect(validatePkceChallenge("a".repeat(43))).toBe(true);
    expect(validatePkceChallenge("a".repeat(42))).toBe(false);
    expect(validatePkceVerifier("A-._~".repeat(9))).toBe(true);
    expect(validatePkceVerifier("spaces are rejected".repeat(3))).toBe(false);
  });

  it("supports only openid scope", () => {
    expect(parseScope(undefined)).toBe("openid");
    expect(parseScope("openid")).toBe("openid");
    expect(() => parseScope("")).toThrow("unsupported_scope");
    expect(() => parseScope("openid email")).toThrow("unsupported_scope");
  });

  it("requires exact redirect URI and GitHub provider allowlist matches", () => {
    expect(() =>
      validateClient(client(), "https://app.example/callback", "github", "https://auth.example"),
    ).not.toThrow();
    expect(() =>
      validateClient(client(), "https://app.example/callback/", "github", "https://auth.example"),
    ).toThrow("invalid redirect_uri");
    expect(() =>
      validateClient(client(undefined, "[]"), null, "github", "https://auth.example"),
    ).toThrow("provider not allowed for client");
    expect(() =>
      validateClient(client(), null, "google" as ProviderName, "https://auth.example"),
    ).toThrow("provider not allowed for client");
  });

  it("rejects malformed client allowlist arrays", () => {
    expect(() =>
      validateClient(
        client("{}"),
        "https://app.example/callback",
        "github",
        "https://auth.example",
      ),
    ).toThrow();
    expect(() =>
      validateClient(client(undefined, "not json"), null, "github", "https://auth.example"),
    ).toThrow();
  });
});
