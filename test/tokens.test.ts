import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { issueIdToken, publicJwk } from "../src/tokens";

const validProviderSub = "prv_github_0u6Y5KwzzMY4exV8ftB_W8";

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
  const token = await issueIdToken(env, "triad-demo", "acct_123", validProviderSub);
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
  expect(payload.provider_sub).toBe(validProviderSub);
  expect(payload.account_sub).toBe("acct_123");
  expect(payload.sub).not.toBe(payload.provider_sub);
  expect(payload).not.toHaveProperty("email");
  expect(payload).not.toHaveProperty("preferred_username");
  expect(payload).not.toHaveProperty("name");
  expect(payload).not.toHaveProperty("picture");
});

it.each([true, false])("issues exactly the supplied standard profile claims with email_verified=%s", async (emailVerified) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;
  const token = await issueIdToken(env, "triad-demo", "acct_123", validProviderSub, {
    email: "user@example.com",
    email_verified: emailVerified,
    preferred_username: "mutable_handle",
    picture: "https://images.example/user",
  });
  const key = await crypto.subtle.importKey(
    "jwk",
    await publicJwk(env),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const { payload } = await jwtVerify(token, key);

  expect(payload).toMatchObject({
    email: "user@example.com",
    email_verified: emailVerified,
    preferred_username: "mutable_handle",
    picture: "https://images.example/user",
  });
  expect(payload).not.toHaveProperty("name");
});

it("rejects non-standard or malformed profile claims", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;

  await expect(issueIdToken(
    env,
    "triad-demo",
    "acct_123",
    validProviderSub,
    { email: "user@example.com", role: "admin" } as never,
  )).rejects.toThrow("invalid profile claims");
});

it("issues a five minute ID token", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;
  const token = await issueIdToken(env, "triad-demo", "acct_123", validProviderSub);
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

  expect(payload.exp! - payload.iat!).toBe(300);
});

it("rejects a pairwise secret shorter than 32 characters", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(31),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;

  await expect(issueIdToken(env, "triad-demo", "acct_123", validProviderSub)).rejects.toThrow(
    "PAIRWISE_SECRET must be at least 32 characters",
  );
});

it.each([
  ["raw provider subject", "github:42"],
  ["unsupported provider", "prv_facebook_0u6Y5KwzzMY4exV8ftB_W8"],
  ["missing prefix", "github_0u6Y5KwzzMY4exV8ftB_W8"],
  ["short opaque value", "prv_github_0u6Y5KwzzMY4exV8ftB_W"],
  ["long opaque value", "prv_github_0u6Y5KwzzMY4exV8ftB_W80"],
  ["invalid opaque character", "prv_github_0u6Y5KwzzMY4exV8ftB_W!"],
] as const)("rejects a %s", async (_description, providerSub) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;

  await expect(issueIdToken(env, "triad-demo", "acct_123", providerSub)).rejects.toThrow(
    "provider_sub must be an opaque Triad provider subject",
  );
});
