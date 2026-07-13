import { describe, expect, it } from "vite-plus/test";
import {
  parseScopes,
  providerScopes,
  serializeScopes,
  validateProviderScopes,
} from "../src/claims";
import { base64url, openClaims, sealClaims } from "../src/crypto";

const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();

const currentClaimsKey = "c".repeat(32);
const previousClaimsKey = "p".repeat(32);
const nextClaimsKey = "n".repeat(32);
const legacyClaimsKey = "l".repeat(32);

function claimsKeyring(active: string, keys: Record<string, string>, legacy?: string): string {
  return JSON.stringify({ active, keys, ...(legacy ? { legacy } : {}) });
}

function decodeBase64url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sealLegacyClaims(
  secret: string,
  context: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("triad-auth-claims-v1"),
      info: encoder.encode("claims-encryption"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(context),
        tagLength: 128,
      },
      key,
      encoder.encode(JSON.stringify(claims)),
    ),
  );
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv);
  payload.set(ciphertext, iv.length);

  return `v1.${base64url(payload)}`;
}

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
    expect(() => validateProviderScopes("google", parseScopes("openid handle"))).toThrow(
      "invalid_scope",
    );
    expect(() => validateProviderScopes("twitter", parseScopes("openid email"))).toThrow(
      "invalid_scope",
    );
    expect(() =>
      validateProviderScopes("github", parseScopes("openid email handle name avatar")),
    ).not.toThrow();
  });
});

describe("transient profile claims", () => {
  it("encrypts claims with the active key and grant-bound authenticated data", async () => {
    const keyring = claimsKeyring("current", {
      current: currentClaimsKey,
      previous: previousClaimsKey,
    });
    const claims = { email: "user@example.com", email_verified: true };
    const sealed = await sealClaims(keyring, "code:abc", claims);
    const resealed = await sealClaims(keyring, "code:abc", claims);

    expect(sealed).toMatch(/^v2\.current\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("user@example.com");
    expect(resealed).not.toBe(sealed);
    await expect(openClaims(keyring, "code:abc", sealed)).resolves.toEqual(claims);
    await expect(openClaims(keyring, "code:other", sealed)).rejects.toThrow();
  });

  it("selects the envelope key and rejects unknown or altered key IDs", async () => {
    const originalKeyring = claimsKeyring("current", { current: currentClaimsKey });
    const rotatedKeyring = claimsKeyring("next", {
      current: currentClaimsKey,
      next: nextClaimsKey,
    });
    const sealed = await sealClaims(originalKeyring, "code:abc", { name: "User" });

    await expect(openClaims(rotatedKeyring, "code:abc", sealed)).resolves.toEqual({ name: "User" });
    await expect(
      openClaims(rotatedKeyring, "code:abc", sealed.replace("v2.current.", "v2.unknown.")),
    ).rejects.toThrow("invalid encrypted claims");

    const aliasedKeyring = claimsKeyring("alias", {
      alias: currentClaimsKey,
      current: currentClaimsKey,
    });
    await expect(
      openClaims(aliasedKeyring, "code:abc", sealed.replace("v2.current.", "v2.alias.")),
    ).rejects.toThrow();
  });

  it("decrypts v1 claims only with a configured legacy key", async () => {
    const claims = { name: "Legacy User" };
    const sealed = await sealLegacyClaims(legacyClaimsKey, "code:abc", claims);
    const currentOnly = claimsKeyring("current", { current: currentClaimsKey });
    const withLegacy = claimsKeyring("current", { current: currentClaimsKey }, legacyClaimsKey);

    await expect(openClaims(withLegacy, "code:abc", sealed)).resolves.toEqual(claims);
    await expect(openClaims(currentOnly, "code:abc", sealed)).rejects.toThrow(
      "invalid encrypted claims",
    );
  });

  it("rejects malformed, tampered, or non-profile claim payloads", async () => {
    const keyring = claimsKeyring("current", { current: currentClaimsKey });
    const sealed = await sealClaims(keyring, "code:abc", { name: "User" });
    const payload = decodeBase64url(sealed.split(".").at(-1)!);
    payload[payload.length - 1] ^= 1;

    await expect(
      openClaims(keyring, "code:abc", `v2.current.${base64url(payload)}`),
    ).rejects.toThrow();
    await expect(openClaims(keyring, "code:abc", "v3.not-supported")).rejects.toThrow();
    await expect(sealClaims(keyring, "code:abc", { role: "admin" } as never)).rejects.toThrow(
      "invalid profile claims",
    );
  });

  it("rejects noncanonical base64url pad bits", async () => {
    const keyring = claimsKeyring("current", { current: currentClaimsKey });
    const sealed = await sealClaims(keyring, "code:abc", { name: "User" });
    const canonical = sealed.split(".").at(-1)!;
    const finalIndex = base64urlAlphabet.indexOf(canonical.at(-1)!);
    const noncanonical = canonical.slice(0, -1) + base64urlAlphabet[finalIndex + 1];

    expect(canonical.length % 4).toBe(2);
    expect(finalIndex % 16).toBe(0);
    expect(decodeBase64url(noncanonical)).toEqual(decodeBase64url(canonical));
    await expect(openClaims(keyring, "code:abc", `v2.current.${noncanonical}`)).rejects.toThrow(
      "invalid encrypted claims",
    );
  });

  it("rejects invalid claims-encryption keyrings", async () => {
    await expect(sealClaims("not json", "code:abc", {})).rejects.toThrow(
      "invalid claims encryption keyring",
    );
    await expect(
      sealClaims(claimsKeyring("invalid.key", { "invalid.key": currentClaimsKey }), "code:abc", {}),
    ).rejects.toThrow("invalid claims encryption keyring");
    await expect(
      sealClaims(claimsKeyring("current", { previous: previousClaimsKey }), "code:abc", {}),
    ).rejects.toThrow("invalid claims encryption keyring");
    await expect(
      sealClaims(
        claimsKeyring("current", {
          current: currentClaimsKey,
          previous: previousClaimsKey,
          next: nextClaimsKey,
        }),
        "code:abc",
        {},
      ),
    ).rejects.toThrow("invalid claims encryption keyring");
    await expect(
      sealClaims(claimsKeyring("current", { current: "short" }), "code:abc", {}),
    ).rejects.toThrow("invalid claims encryption keyring");
    await expect(
      openClaims(
        claimsKeyring("current", { current: currentClaimsKey }, "short"),
        "code:abc",
        "v1.invalid",
      ),
    ).rejects.toThrow("invalid claims encryption keyring");
  });
});
