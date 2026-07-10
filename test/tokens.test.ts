import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { issueIdToken, publicJwk } from "../src/tokens";

it("exports a public signing JWK without private key material", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = { SIGNING_PRIVATE_JWK: JSON.stringify(jwk) } as never;

  const publicKey = await publicJwk(env);

  expect(publicKey).not.toHaveProperty("d");
  expect(publicKey).toMatchObject({ use: "sig", alg: "ES256", kid: "test" });
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
