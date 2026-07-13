import { importJWK, SignJWT } from "jose";
import { validateProfileClaims } from "./claims";
import { pairwiseSubject } from "./crypto";
import type { Env, ProfileClaims } from "./types";

export async function issueIdToken(
  env: Env,
  clientId: string,
  accountId: string,
  providerSub: string,
  claims: ProfileClaims = {},
): Promise<string> {
  if (!/^pid_(google|github|twitter)_[0-9a-f]{64}$/.test(providerSub)) {
    throw new Error("provider_sub must be an opaque Triad provider subject");
  }
  if (env.IDENTIFIER_SECRET.length < 32) {
    throw new Error("IDENTIFIER_SECRET must be at least 32 characters");
  }

  const privateJwk = JSON.parse(env.SIGNING_PRIVATE_JWK) as JsonWebKey & {
    kid?: string;
  };
  const key = await importJWK(privateJwk, "ES256");
  const pairwiseSub = await pairwiseSubject(env.IDENTIFIER_SECRET, accountId, clientId);

  const profileClaims = validateProfileClaims(claims);

  return new SignJWT({
    provider_sub: providerSub,
    account_sub: accountId,
    pairwise_sub: pairwiseSub,
    ...profileClaims,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "JWT",
      kid: privateJwk.kid ?? "main",
    })
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
