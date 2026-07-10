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
    .setExpirationTime("10m")
    .setJti(crypto.randomUUID())
    .sign(key);
}

export async function publicJwk(env: Env): Promise<Record<string, unknown>> {
  const jwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as JsonWebKey & { kid?: string };
  delete jwk.d;
  return { ...jwk, use: "sig", alg: "ES256", kid: jwk.kid ?? "main" };
}
