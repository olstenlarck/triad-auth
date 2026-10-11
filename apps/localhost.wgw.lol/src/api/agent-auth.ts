import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SignJWT, importJWK, jwtVerify, type JWK } from "jose";

import { SCOPES, hashUserCode, isScope, newToken, newUserCode } from "../auth";
import { appEnv, db } from "../context";
import { claimRegistrationToken, consumeDeviceCode, registrationHasToken } from "../db";
import {
  isRecord,
  randomBytes,
  randomId,
  sha256Hex,
  timingSafeEqual,
  base64UrlEncode,
  now,
} from "../utils";
import { HttpError, principalOf, readForm } from "./http";

export const agentAuth = new Hono();

export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const PRE_CLAIM_SCOPES: string[] = [];
const POST_CLAIM_SCOPES = ["repo:read", "repo:write", "env:read", "user:read"];
const DEVICE_DEFAULT_SCOPES = [
  "repo:read",
  "repo:write",
  "repo:admin",
  "env:read",
  "env:write",
  "user:read",
];
const REGISTRATION_TTL = 60 * 60 * 24;
const ASSERTION_TTL = 60 * 60;
const CLAIM_ATTEMPT_TTL = 600;
const DEVICE_TTL = 900;
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30;

interface SigningKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

let signingKey: Promise<SigningKey> | null = null;

function loadSigningKey(): Promise<SigningKey> {
  if (!signingKey) {
    signingKey = (async () => {
      // SAFETY: JWT_PRIVATE_JWK is the deploy-time secret holding the ES256 signing key as a JWK document.
      const jwk = JSON.parse(appEnv().JWT_PRIVATE_JWK) as JWK;
      const { d: _d, ...publicJwk } = jwk;
      const privateKey = await importJWK(jwk, "ES256");
      const publicKey = await importJWK(publicJwk, "ES256");
      if (!(privateKey instanceof CryptoKey && publicKey instanceof CryptoKey)) {
        throw new Error("JWT_PRIVATE_JWK must be an EC P-256 key");
      }
      const kid =
        jwk.kid ??
        sha256Hex(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })).slice(0, 16);

      return {
        privateKey,
        publicKey,
        publicJwk: { ...publicJwk, kid, use: "sig", alg: "ES256" },
        kid,
      };
    })();
    signingKey.catch(() => {
      signingKey = null;
    });
  }

  return signingKey;
}

function oauthError(
  c: Parameters<typeof principalOf>[0],
  status: ContentfulStatusCode,
  error: string,
  description?: string,
): Response {
  return c.json({ error, error_description: description }, status);
}

async function mintAssertion(
  registrationId: string,
  email: string | null,
): Promise<{ token: string; expiresAt: string }> {
  const origin = appEnv().APP_ORIGIN;
  const key = await loadSigningKey();
  const expires = now() + ASSERTION_TTL;
  const builder = new SignJWT(email ? { email, email_verified: true } : {})
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "oauth-id-jag+jwt" })
    .setIssuer(origin)
    .setAudience(origin)
    .setSubject(registrationId)
    .setIssuedAt()
    .setJti(randomId(20))
    .setExpirationTime(expires);

  return {
    token: await builder.sign(key.privateKey),
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

async function issueAccessToken(
  userId: string,
  scopes: string[],
  name: string,
  registrationId: string | null = null,
): Promise<{ token: string; expiresIn: number; scope: string; id: string }> {
  const created = newToken();
  const row = await db().createToken({
    userId,
    name,
    prefix: created.prefix,
    hash: created.hash,
    scopes,
    registrationId,
    expiresAt: now() + ACCESS_TOKEN_TTL,
  });

  return {
    token: created.plaintext,
    expiresIn: ACCESS_TOKEN_TTL,
    scope: scopes.join(" "),
    id: row.id,
  };
}

// ---- discovery documents ----

export function protectedResourceMetadata() {
  const origin = appEnv().APP_ORIGIN;

  return {
    resource: `${origin}/`,
    resource_name: "localhost",
    resource_logo_uri: `${origin}/logo.svg`,
    authorization_servers: [`${origin}/`],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata() {
  const origin = appEnv().APP_ORIGIN;

  return {
    ...protectedResourceMetadata(),
    issuer: origin,
    token_endpoint: `${origin}/oauth2/token`,
    revocation_endpoint: `${origin}/oauth2/revoke`,
    device_authorization_endpoint: `${origin}/oauth2/device_authorization`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    grant_types_supported: [JWT_BEARER_GRANT, CLAIM_GRANT, DEVICE_GRANT],
    token_endpoint_auth_methods_supported: ["none"],
    agent_auth: {
      skill: `${origin}/auth.md`,
      identity_endpoint: `${origin}/agent/identity`,
      claim_endpoint: `${origin}/agent/identity/claim`,
      identity_types_supported: ["anonymous"],
    },
  };
}

agentAuth.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata()));
agentAuth.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata()),
);
agentAuth.get("/.well-known/openid-configuration", (c) => c.json(authorizationServerMetadata()));
agentAuth.get("/.well-known/jwks.json", async (c) => {
  const key = await loadSigningKey();

  return c.json({ keys: [key.publicJwk] });
});

// ---- auth.md: anonymous registration and the claim ceremony ----

agentAuth.post("/agent/identity", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || body.type !== "anonymous") {
    if (isRecord(body) && (body.type === "identity_assertion" || body.type === "service_auth")) {
      return oauthError(
        c,
        400,
        "anonymous_only",
        'this service accepts only type "anonymous"; see /auth.md',
      );
    }

    return oauthError(c, 400, "invalid_request", 'body must be {"type":"anonymous"}');
  }
  const claimToken = `clm_${base64UrlEncode(randomBytes(24))}`;
  const registrationId = await db().createAgentRegistration({
    claimTokenHash: sha256Hex(claimToken),
    ttl: REGISTRATION_TTL,
  });
  const assertion = await mintAssertion(registrationId, null);
  const origin = appEnv().APP_ORIGIN;

  return c.json({
    registration_id: registrationId,
    registration_type: "anonymous",
    identity_assertion: assertion.token,
    assertion_expires: assertion.expiresAt,
    pre_claim_scopes: PRE_CLAIM_SCOPES,
    claim_url: `${origin}/agent/identity/claim`,
    claim_token: claimToken,
    claim_token_expires: new Date((now() + REGISTRATION_TTL) * 1000).toISOString(),
    post_claim_scopes: POST_CLAIM_SCOPES,
  });
});

agentAuth.post("/agent/identity/claim", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.claim_token !== "string") {
    return oauthError(c, 400, "invalid_request", "claim_token is required");
  }
  const registration = await db().agentRegistrationByClaimHash(sha256Hex(body.claim_token));
  if (!registration) {
    return oauthError(
      c,
      400,
      "invalid_claim_token",
      "unknown claim token; register again at /agent/identity",
    );
  }
  if (registration.expires_at < now()) {
    return oauthError(c, 410, "claim_expired", "the registration window closed; register again");
  }
  if (registration.status === "claimed") {
    return oauthError(c, 409, "claimed_or_in_flight", "this registration is already claimed");
  }
  const email =
    typeof body.email === "string" && body.email.includes("@")
      ? body.email.trim().toLowerCase()
      : null;
  const userCode = String(100_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900_000));
  const attemptToken = `cat_${base64UrlEncode(randomBytes(24))}`;
  const attemptId = await db().createClaimAttempt({
    registrationId: registration.id,
    attemptToken,
    userCodeHash: hashUserCode(userCode),
    ttl: CLAIM_ATTEMPT_TTL,
  });
  await db().updateAgentRegistration(registration.id, { claim_email: email });
  const origin = appEnv().APP_ORIGIN;
  const claimPage = `/claim?claim_attempt_token=${encodeURIComponent(attemptToken)}`;

  return c.json({
    registration_id: registration.id,
    claim_attempt_id: attemptId,
    status: "initiated",
    expires_at: new Date((now() + CLAIM_ATTEMPT_TTL) * 1000).toISOString(),
    claim_attempt: {
      user_code: userCode,
      expires_in: CLAIM_ATTEMPT_TTL,
      verification_uri: `${origin}/login?return_to=${encodeURIComponent(claimPage)}`,
      interval: 5,
    },
  });
});

// The signed-in human types the code the agent showed them. Served to the /claim page.
agentAuth.get("/agent/identity/claim/view", async (c) => {
  const principal = await principalOf(c);
  const attempt = await db().claimAttemptByToken(c.req.query("claim_attempt_token") ?? "");
  if (!attempt) {
    throw new HttpError(
      404,
      "this claim link expired or was used; ask the agent for a new one",
      "not_found",
    );
  }
  const registration = await db().agentRegistrationById(attempt.registration_id);
  const emails = principal
    ? (await db().identitiesOf(principal.user.id)).map((identity) => identity.email?.toLowerCase())
    : [];

  return c.json({
    signed_in: principal ? { handle: principal.user.handle, emails: emails.filter(Boolean) } : null,
    claim_email: registration?.claim_email ?? null,
    email_matches:
      !registration?.claim_email || emails.includes(registration.claim_email.toLowerCase()),
  });
});

agentAuth.post("/agent/identity/claim/complete", async (c) => {
  const principal = await principalOf(c);
  if (!principal || principal.via !== "session") {
    throw new HttpError(401, "sign in first", "unauthorized");
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.claim_attempt_token !== "string" ||
    typeof body.user_code !== "string"
  ) {
    throw new HttpError(400, "claim_attempt_token and user_code are required", "invalid_request");
  }
  const attempt = await db().claimAttemptByToken(body.claim_attempt_token);
  if (!attempt) {
    throw new HttpError(404, "this claim link expired or was used", "not_found");
  }
  // Five wrong codes end the attempt; the agent has to start a new one.
  const failKey = `claim-fail:${attempt.id}`;
  const failures = Number((await appEnv().KV.get(failKey)) ?? 0);
  if (failures >= 5) {
    throw new HttpError(429, "too many wrong codes; ask the agent for a new link", "rate_limited");
  }
  if (!timingSafeEqual(hashUserCode(body.user_code), attempt.user_code_hash)) {
    await appEnv().KV.put(failKey, String(failures + 1), { expirationTtl: CLAIM_ATTEMPT_TTL });
    throw new HttpError(400, "the code does not match", "invalid_code");
  }
  const registration = await db().agentRegistrationById(attempt.registration_id);
  if (!registration || registration.status !== "pending") {
    throw new HttpError(409, "this registration is no longer pending", "conflict");
  }
  if (registration.claim_email) {
    const emails = (await db().identitiesOf(principal.user.id)).map((identity) =>
      identity.email?.toLowerCase(),
    );
    if (!emails.includes(registration.claim_email.toLowerCase())) {
      throw new HttpError(
        403,
        `sign in as ${registration.claim_email} to claim this agent`,
        "email_mismatch",
      );
    }
  }
  await db().completeClaimAttempt(attempt.id);
  await db().updateAgentRegistration(registration.id, {
    status: "claimed",
    user_id: principal.user.id,
  });

  return c.json({ claimed: true, registration_id: registration.id });
});

// ---- RFC 8628 device authorization for the CLI ----

agentAuth.post("/oauth2/device_authorization", async (c) => {
  const form = await readForm(c);
  const requested = String(form.scope ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const scopes = requested.length > 0 ? requested.filter(isScope) : DEVICE_DEFAULT_SCOPES;
  const deviceCode = `dvc_${base64UrlEncode(randomBytes(30))}`;
  const userCode = newUserCode();
  await db().createDeviceCode({
    deviceCodeHash: sha256Hex(deviceCode),
    userCode,
    scopes,
    tokenName: String(form.client_name ?? "lh cli").slice(0, 60),
    ttl: DEVICE_TTL,
  });
  const origin = appEnv().APP_ORIGIN;

  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?code=${userCode}`,
    expires_in: DEVICE_TTL,
    interval: 5,
  });
});

// The device page shows what a code asks for before the person approves it.
agentAuth.get("/oauth2/device/lookup", async (c) => {
  const principal = await principalOf(c);
  if (!principal || principal.via !== "session") {
    throw new HttpError(401, "sign in first", "unauthorized");
  }
  const code = (c.req.query("user_code") ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : "";
  const device = formatted ? await db().deviceCodeByUserCode(formatted) : null;
  if (!device || device.status !== "pending") {
    throw new HttpError(404, "unknown or expired code", "not_found");
  }

  return c.json({ name: device.token_name, scopes: device.scopes.split(" ") });
});

agentAuth.post("/oauth2/device/approve", async (c) => {
  const principal = await principalOf(c);
  if (!principal || principal.via !== "session") {
    throw new HttpError(401, "sign in first", "unauthorized");
  }
  const body: unknown = await c.req.json().catch(() => null);
  const code =
    isRecord(body) && typeof body.user_code === "string"
      ? body.user_code.toUpperCase().replace(/[^A-Z]/g, "")
      : "";
  const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : "";
  const device = formatted ? await db().deviceCodeByUserCode(formatted) : null;
  if (!device || device.status !== "pending") {
    throw new HttpError(404, "unknown or expired code", "not_found");
  }
  const decision = isRecord(body) && body.approve === false ? "denied" : "approved";
  await db().setDeviceCodeStatus(device.id, decision, principal.user.id);

  return c.json({ status: decision, scopes: device.scopes.split(" "), name: device.token_name });
});

// ---- token endpoint ----

agentAuth.post("/oauth2/token", async (c) => {
  const form = await readForm(c);
  const grant = String(form.grant_type ?? "");

  if (grant === DEVICE_GRANT) {
    const deviceCode = String(form.device_code ?? "");
    const device = deviceCode ? await db().deviceCodeByHash(sha256Hex(deviceCode)) : null;
    if (!device) {
      return oauthError(c, 400, "expired_token", "unknown or expired device code");
    }
    if (device.status === "pending") {
      return oauthError(c, 400, "authorization_pending", "waiting for the user to approve");
    }
    if (device.status === "denied") {
      return oauthError(c, 400, "access_denied", "the user denied the request");
    }
    if (
      device.status !== "approved" ||
      !device.user_id ||
      !(await consumeDeviceCode(appEnv().DB, device.id))
    ) {
      return oauthError(c, 400, "invalid_grant", "device code already used");
    }
    const issued = await issueAccessToken(
      device.user_id,
      device.scopes.split(" "),
      device.token_name,
    );
    const user = await db().userById(device.user_id);

    return c.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      scope: issued.scope,
      handle: user?.handle,
    });
  }

  if (grant === CLAIM_GRANT) {
    const claimToken = String(form.claim_token ?? "");
    const registration = claimToken
      ? await db().agentRegistrationByClaimHash(sha256Hex(claimToken))
      : null;
    if (!registration) {
      return oauthError(c, 400, "invalid_grant", "unknown claim token");
    }
    if (registration.expires_at < now()) {
      return oauthError(c, 400, "expired_token", "the registration window closed; register again");
    }
    if (registration.status !== "claimed" || !registration.user_id) {
      return oauthError(
        c,
        400,
        "authorization_pending",
        "the user has not completed the claim ceremony",
      );
    }
    if (registration.token_id) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "this claim was already exchanged; use the identity_assertion",
      );
    }
    const user = await db().userById(registration.user_id);
    const issued = await issueAccessToken(
      registration.user_id,
      POST_CLAIM_SCOPES,
      `agent ${registration.id.slice(4, 12)}`,
      registration.id,
    );
    if (!(await claimRegistrationToken(appEnv().DB, registration.id, issued.id))) {
      await db().deleteTokenRow(issued.id);

      return oauthError(
        c,
        400,
        "invalid_grant",
        "this claim was already exchanged; use the identity_assertion",
      );
    }
    const email =
      (await db().identitiesOf(registration.user_id)).find((identity) => identity.email)?.email ??
      null;
    const assertion = await mintAssertion(registration.id, email);

    return c.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      scope: issued.scope,
      handle: user?.handle,
      identity_assertion: assertion.token,
      assertion_expires: assertion.expiresAt,
    });
  }

  if (grant === JWT_BEARER_GRANT) {
    const assertion = String(form.assertion ?? "");
    const key = await loadSigningKey();
    const origin = appEnv().APP_ORIGIN;
    let subject: string;
    try {
      const { payload } = await jwtVerify(assertion, key.publicKey, {
        issuer: origin,
        audience: origin,
        algorithms: ["ES256"],
      });
      subject = payload.sub ?? "";
    } catch {
      return oauthError(c, 400, "invalid_grant", "the identity_assertion is invalid or expired");
    }
    const registration = await db().agentRegistrationById(subject);
    if (!registration || registration.status !== "claimed" || !registration.user_id) {
      return oauthError(c, 400, "invalid_grant", "complete the claim ceremony first");
    }
    // Deleting the agent token under Settings revokes the registration as well.
    if (!registration.token_id || !(await registrationHasToken(appEnv().DB, registration.id))) {
      return oauthError(c, 400, "invalid_grant", "this registration was revoked; register again");
    }
    const issued = await issueAccessToken(
      registration.user_id,
      POST_CLAIM_SCOPES,
      `agent ${registration.id.slice(4, 12)}`,
      registration.id,
    );

    return c.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      scope: issued.scope,
    });
  }

  return oauthError(
    c,
    400,
    "unsupported_grant_type",
    `supported: ${DEVICE_GRANT}, ${CLAIM_GRANT}, ${JWT_BEARER_GRANT}`,
  );
});

agentAuth.post("/oauth2/revoke", async (c) => {
  const form = await readForm(c);
  const token = String(form.token ?? "");
  if (token) {
    const row = await db().tokenByHash(sha256Hex(token));
    if (row) {
      await db().deleteToken(row.user_id, row.id);
    }
  }

  return c.body(null, 200);
});
