import { importJWK, SignJWT } from "jose";
import { pairwiseSubject } from "./crypto";
import type { Env } from "./types";

export async function issueIdToken(
  env: Env,
  clientId: string,
  accountId: string,
  providerSub: string,
): Promise<string> {
  if (env.PAIRWISE_SECRET.length < 32) {
    throw new Error("PAIRWISE_SECRET must be at least 32 characters");
  }
  const privateJwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as JsonWebKey & { kid?: string };
  const key = await importJWK(privateJwk, "ES256");
  const pairwiseSub = await pairwiseSubject(env.PAIRWISE_SECRET, accountId, clientId);
  return new SignJWT({
    provider_sub: providerSub,
    account_sub: accountId,
    pairwise_sub: pairwiseSub,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: privateJwk.kid ?? "main" })
    .setIssuer(env.ISSUER)
    .setAudience(clientId)
    .setSubject(pairwiseSub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(key);
}

export async function publicJwk(env: Env): Promise<Record<string, unknown>> {
  const jwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as Record<string, unknown>;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    typeof jwk.d !== "string"
  ) {
    throw new Error("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
  }
  try {
    await importJWK(jwk as JsonWebKey, "ES256");
  } catch {
    throw new Error("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
  }
  return {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    kid: typeof jwk.kid === "string" ? jwk.kid : "main",
  };
}
