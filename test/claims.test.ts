import { describe, expect, it } from "vitest";
import {
  parseScopes,
  providerScopes,
  serializeScopes,
  validateProviderScopes,
} from "../src/claims";
import { openClaims, sealClaims } from "../src/crypto";

describe("privacy scopes", () => {
  it("defaults to identity only and canonicalizes requested scopes", () => {
    expect(parseScopes()).toEqual(["openid"]);
    expect(parseScopes("avatar openid email email")).toEqual(["openid", "email", "avatar"]);
    expect(serializeScopes(["avatar", "openid", "email"])).toBe("openid email avatar");
    expect(() => parseScopes("email")).toThrow("invalid_scope");
    expect(() => parseScopes("openid phone")).toThrow("invalid_scope");
    expect(() => parseScopes("")).toThrow("invalid_scope");
  });

  it("reports and enforces provider capabilities", () => {
    expect(providerScopes("google")).toEqual(["email", "name", "avatar"]);
    expect(providerScopes("github")).toEqual(["email", "handle", "name", "avatar"]);
    expect(providerScopes("twitter")).toEqual(["handle", "name", "avatar"]);
    expect(() => validateProviderScopes("google", parseScopes("openid handle"))).toThrow("invalid_scope");
    expect(() => validateProviderScopes("twitter", parseScopes("openid email"))).toThrow("invalid_scope");
    expect(() => validateProviderScopes("github", parseScopes("openid email handle name avatar")))
      .not.toThrow();
  });
});

describe("transient profile claims", () => {
  it("encrypts claims with fresh IVs and grant-bound authenticated data", async () => {
    const secret = "s".repeat(32);
    const claims = { email: "user@example.com", email_verified: true };
    const sealed = await sealClaims(secret, "code:abc", claims);
    const resealed = await sealClaims(secret, "code:abc", claims);

    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("user@example.com");
    expect(resealed).not.toBe(sealed);
    await expect(openClaims(secret, "code:abc", sealed)).resolves.toEqual(claims);
    await expect(openClaims(secret, "code:other", sealed)).rejects.toThrow();
  });

  it("rejects malformed, tampered, or non-profile claim payloads", async () => {
    const secret = "s".repeat(32);
    const sealed = await sealClaims(secret, "code:abc", { name: "User" });
    const replacement = sealed.endsWith("A") ? "B" : "A";

    await expect(openClaims(secret, "code:abc", sealed.slice(0, -1) + replacement)).rejects.toThrow();
    await expect(openClaims(secret, "code:abc", "v2.not-supported")).rejects.toThrow();
    await expect(sealClaims(secret, "code:abc", { role: "admin" } as never)).rejects.toThrow(
      "invalid profile claims",
    );
  });

  it("requires a sufficiently strong claims-encryption secret", async () => {
    await expect(sealClaims("short", "code:abc", {})).rejects.toThrow("at least 32 characters");
    await expect(openClaims("short", "code:abc", "v1.invalid")).rejects.toThrow("at least 32 characters");
  });
});
