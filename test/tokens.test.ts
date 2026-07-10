import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { issueIdToken, publicJwk } from "../src/tokens";

it("exports only allowlisted public signing JWK fields", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = {
    ...(await exportJWK(privateKey)),
    kid: "test",
    k: "symmetric-secret",
    p: "rsa-p",
    q: "rsa-q",
    dp: "rsa-dp",
    dq: "rsa-dq",
    qi: "rsa-qi",
    oth: [{ r: "rsa-r", d: "rsa-d", t: "rsa-t" }],
    custom: "not-public-metadata",
  };
  const env = { SIGNING_PRIVATE_JWK: JSON.stringify(jwk) } as never;

  const publicKey = await publicJwk(env);

  expect(publicKey).toStrictEqual({
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    kid: "test",
  });
});

it.each([
  ["non-EC key type", "kty", "RSA"],
  ["non-P-256 curve", "crv", "P-384"],
  ["missing x coordinate", "x", undefined],
  ["non-string y coordinate", "y", 42],
  ["missing private scalar", "d", undefined],
] as const)("rejects an invalid signing JWK with %s", async (_description, field, value) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), [field]: value };
  const env = { SIGNING_PRIVATE_JWK: JSON.stringify(jwk) } as never;

  await expect(publicJwk(env)).rejects.toThrow(
    "SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key",
  );
});

it("issues a pairwise standard subject plus explicit global subjects", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;
  const token = await issueIdToken(env, "triad-demo", "acct_123", "github:42");
  const key = await crypto.subtle.importKey(
    "jwk",
    await publicJwk(env),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const { payload } = await jwtVerify(token, key, {
    issuer: "https://issuer.example",
    audience: "triad-demo",
  });
  expect(payload.sub).toBe(payload.pairwise_sub);
  expect(payload.provider_sub).toBe("github:42");
  expect(payload.account_sub).toBe("acct_123");
  expect(payload.sub).not.toBe(payload.provider_sub);
});

it("rejects a pairwise secret shorter than 32 characters", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(31),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;

  await expect(issueIdToken(env, "triad-demo", "acct_123", "github:42")).rejects.toThrow(
    "PAIRWISE_SECRET must be at least 32 characters",
  );
});
