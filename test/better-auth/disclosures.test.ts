import { describe, expect, it } from "vite-plus/test";

import {
  DISCLOSURE_CLAIMS,
  DISCLOSURE_SCOPES,
  PROFILE_DISCLOSURE_SCOPES,
  PROVIDER_DISCLOSURE_SCOPES,
  PROVIDER_UPSTREAM_SCOPE_MAP,
  canonicalDisclosureScopes,
  claimsForDisclosureScopes,
  upstreamScopesForProvider,
  validateProviderDisclosureScopes,
} from "../../src/better-auth/disclosures";

describe("downstream disclosure scope policy", () => {
  it("defines the exact canonical scope vocabulary and identity-only default", () => {
    expect(DISCLOSURE_SCOPES).toEqual([
      "openid",
      "email",
      "handle",
      "name",
      "avatar",
      "wallet",
      "chains",
      "chain_id",
      "cred",
      "pubkey",
    ]);
    expect(PROFILE_DISCLOSURE_SCOPES).toEqual([
      "email",
      "handle",
      "name",
      "avatar",
      "wallet",
      "chains",
      "cred",
      "pubkey",
    ]);
    expect(canonicalDisclosureScopes()).toEqual(["openid"]);
    expect(canonicalDisclosureScopes([])).toEqual(["openid"]);
  });

  it("requires openid and canonicalizes independent profile scopes", () => {
    expect(canonicalDisclosureScopes(["avatar", "openid", "email"])).toEqual([
      "openid",
      "email",
      "avatar",
    ]);
    expect(() => canonicalDisclosureScopes(["email"])).toThrow("openid");
    expect(() => canonicalDisclosureScopes(["openid", "profile"])).toThrow("profile");
    expect(() => canonicalDisclosureScopes(["openid", "email", "email"])).toThrow("duplicate");
  });

  it("maps each disclosure scope to its standard claims", () => {
    expect(DISCLOSURE_CLAIMS).toEqual({
      openid: ["pairwise_sub", "account_sub", "provider_sub"],
      email: ["email", "email_verified"],
      handle: ["preferred_username"],
      name: ["name"],
      avatar: ["picture"],
      wallet: ["wallet"],
      chains: ["chains"],
      chain_id: ["chain_id"],
      cred: ["cred"],
      pubkey: ["pubkey"],
    });
    expect(claimsForDisclosureScopes(["openid", "email", "avatar"])).toEqual([
      "pairwise_sub",
      "account_sub",
      "provider_sub",
      "email",
      "email_verified",
      "picture",
    ]);
  });

  it("defines truthful provider capabilities", () => {
    expect(PROVIDER_DISCLOSURE_SCOPES).toEqual({
      google: ["email", "name", "avatar"],
      github: ["email", "handle", "name", "avatar"],
      twitter: ["handle", "name", "avatar"],
      ethereum: ["wallet", "chains", "chain_id"],
      passkey: ["cred", "pubkey"],
    });
    expect(() =>
      validateProviderDisclosureScopes("github", ["openid", "email", "handle", "name", "avatar"]),
    ).not.toThrow();
    expect(() => validateProviderDisclosureScopes("google", ["openid", "handle"])).toThrow(
      "handle",
    );
    expect(() => validateProviderDisclosureScopes("twitter", ["openid", "email"])).toThrow("email");
    expect(() =>
      validateProviderDisclosureScopes("ethereum", ["openid", "wallet", "chains", "chain_id"]),
    ).not.toThrow();
    expect(() =>
      validateProviderDisclosureScopes("passkey", ["openid", "cred", "pubkey"]),
    ).not.toThrow();
  });

  it("maps disclosures to only the upstream scopes each provider needs", () => {
    expect(PROVIDER_UPSTREAM_SCOPE_MAP).toEqual({
      google: {
        openid: ["openid"],
        email: ["email"],
        handle: [],
        name: ["profile"],
        avatar: ["profile"],
        wallet: [],
        chains: [],
        chain_id: [],
        cred: [],
        pubkey: [],
      },
      github: {
        openid: [],
        email: ["user:email"],
        handle: [],
        name: [],
        avatar: [],
        wallet: [],
        chains: [],
        chain_id: [],
        cred: [],
        pubkey: [],
      },
      twitter: {
        openid: ["tweet.read", "users.read"],
        email: [],
        handle: [],
        name: [],
        avatar: [],
        wallet: [],
        chains: [],
        chain_id: [],
        cred: [],
        pubkey: [],
      },
      ethereum: {
        openid: [],
        email: [],
        handle: [],
        name: [],
        avatar: [],
        wallet: [],
        chains: [],
        chain_id: [],
        cred: [],
        pubkey: [],
      },
      passkey: {
        openid: [],
        email: [],
        handle: [],
        name: [],
        avatar: [],
        wallet: [],
        chains: [],
        chain_id: [],
        cred: [],
        pubkey: [],
      },
    });
    expect(upstreamScopesForProvider("google", ["openid", "avatar", "email", "name"])).toEqual([
      "openid",
      "email",
      "profile",
    ]);
    expect(upstreamScopesForProvider("github", ["openid", "email", "name"])).toEqual([
      "user:email",
    ]);
    expect(upstreamScopesForProvider("twitter", ["openid", "avatar"])).toEqual([
      "tweet.read",
      "users.read",
    ]);
  });
});
