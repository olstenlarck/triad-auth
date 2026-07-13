import { importJWK, SignJWT } from "jose";
import { validateProfileClaims } from "./claims";
import { pairwiseSubject } from "./crypto";
import type { Env, ProfileClaims } from "./types";

interface PrivateSigningJwk extends JsonWebKey {
  kid: string;
}

interface SigningKey {
  jwk: PrivateSigningJwk;
  key: Awaited<ReturnType<typeof importJWK>>;
}

async function parseSigningKeyring(env: Env): Promise<{
  active: SigningKey;
  keys: SigningKey[];
}> {
  let value: unknown;
  try {
    value = JSON.parse(env.SIGNING_KEYRING);
  } catch {
    throw new Error("Invalid SIGNING_KEYRING");
  }

  if (!value || typeof value !== "object") {
    throw new Error("Invalid SIGNING_KEYRING");
  }
  const keyring = value as { active_kid?: unknown; keys?: unknown };
  if (
    typeof keyring.active_kid !== "string" ||
    keyring.active_kid.length === 0 ||
    !Array.isArray(keyring.keys) ||
    keyring.keys.length < 1 ||
    keyring.keys.length > 2
  ) {
    throw new Error("Invalid SIGNING_KEYRING");
  }

  const seenKids = new Set<string>();
  const keys: SigningKey[] = [];
  for (const value of keyring.keys) {
    if (!value || typeof value !== "object") {
      throw new Error("SIGNING_KEYRING contains an invalid private key");
    }
    const jwk = value as Record<string, unknown>;
    if (typeof jwk.kid !== "string" || jwk.kid.length === 0 || seenKids.has(jwk.kid)) {
      throw new Error("Invalid SIGNING_KEYRING");
    }
    seenKids.add(jwk.kid);

    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      typeof jwk.d !== "string" ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.alg !== undefined && jwk.alg !== "ES256")
    ) {
      throw new Error("SIGNING_KEYRING contains an invalid private key");
    }

    try {
      keys.push({
        jwk: value as PrivateSigningJwk,
        key: await importJWK(value as JsonWebKey, "ES256"),
      });
    } catch {
      throw new Error("SIGNING_KEYRING contains an invalid private key");
    }
  }

  const active = keys.find(({ jwk }) => jwk.kid === keyring.active_kid);
  if (!active) {
    throw new Error("Invalid SIGNING_KEYRING");
  }

  return { active, keys };
}

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
  if (env.PAIRWISE_SECRET.length < 32) {
    throw new Error("PAIRWISE_SECRET must be at least 32 characters");
  }

  const keyring = await parseSigningKeyring(env);
  const pairwiseSub = await pairwiseSubject(env.PAIRWISE_SECRET, accountId, clientId);

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
      kid: keyring.active.jwk.kid,
    })
    .setIssuer(env.ISSUER)
    .setAudience(clientId)
    .setSubject(pairwiseSub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(keyring.active.key);
}

export async function publicJwks(env: Env): Promise<Record<string, unknown>[]> {
  const keyring = await parseSigningKeyring(env);

  return keyring.keys.map(({ jwk }) => ({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    kid: jwk.kid,
  }));
}
