import { exportJWK, importJWK, SignJWT } from "jose";
import { pairwiseSubject } from "./crypto";
import type { Env } from "./types";

export async function issueIdToken(
  env: Env,
  clientId: string,
  accountId: string,
  providerSub: string,
): Promise<string> {
  const privateJwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as JsonWebKey & { kid?: string };
  const key = await importJWK(privateJwk, "ES256");
  return new SignJWT({
    provider_sub: providerSub,
    account_sub: accountId,
    pairwise_sub: await pairwiseSubject(env.PAIRWISE_SECRET, accountId, clientId),
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: privateJwk.kid ?? "main" })
    .setIssuer(env.ISSUER)
    .setAudience(clientId)
    .setSubject(providerSub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(crypto.randomUUID())
    .sign(key);
}

export async function publicJwk(env: Env): Promise<Record<string, unknown>> {
  const privateJwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as JsonWebKey & { kid?: string };
  const key = await importJWK(privateJwk, "ES256");
  const jwk = await exportJWK(key);
  delete jwk.d;
  return { ...jwk, use: "sig", alg: "ES256", kid: privateJwk.kid ?? "main" };
}
