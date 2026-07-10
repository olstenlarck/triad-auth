import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { randomToken, sha256, timingSafeEqual } from "../crypto";
import {
  approveDeviceGrant,
  consumeAuthorizationCode,
  consumeApprovedDeviceGrant,
  consumeTransaction,
  denyDeviceGrant,
  getAuthorizationCode,
  getClient,
  getDeviceGrantState,
  pollPendingDeviceGrant,
  rememberConsent,
  resolveIdentity,
  validateClient,
} from "../db";
import { finishProvider, startProvider } from "../providers";
import { parseScope, validatePkceChallenge, validatePkceVerifier } from "../protocol";
import { assertSameOrigin, consumeCsrfToken, createCsrfToken } from "../security";
import { issueIdToken, publicJwk } from "../tokens";
import type { Env, ProviderName } from "../types";

const now = () => Math.floor(Date.now() / 1000);
const consentPurpose = (requestHash: string) => `consent:${requestHash}`;
const oauthBodyLimit = 4096;
const clientIdLimit = 128;
const authorizationCodeLimit = 128;
const deviceCodeLimit = 128;
const redirectUriLimit = 2048;

export const oauthError = (error: string, description?: string, status = 400) =>
  new Response(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
  });

interface ConsentRequestRow {
  request_hash: string;
  client_id: string;
  redirect_uri: string;
  app_state: string;
  provider: ProviderName;
  code_challenge: string;
  scopes: string;
  expires_at: number;
}

async function consumeConsentRequest(db: D1Database, requestHash: string): Promise<ConsentRequestRow | null> {
  const row = await db.prepare("SELECT * FROM consent_requests WHERE request_hash = ? AND expires_at > unixepoch()")
    .bind(requestHash).first<ConsentRequestRow>();
  if (!row) return null;
  const consumed = await db.prepare("DELETE FROM consent_requests WHERE request_hash = ?").bind(requestHash).run();
  return consumed.meta.changes === 1 ? row : null;
}

async function requireConsentMutation(
  db: D1Database,
  ticket: string,
  csrfToken: string,
): Promise<string | Response> {
  const requestHash = await sha256(ticket);
  const valid = await consumeCsrfToken(db, csrfToken, consentPurpose(requestHash));
  return valid ? requestHash : oauthError("invalid_request", "invalid CSRF token", 403);
}

export function requireSameOrigin(request: Request, issuer: string): Response | null {
  try {
    assertSameOrigin(request, issuer);
  } catch {
    return oauthError("invalid_request", "invalid origin", 403);
  }
  return null;
}

export async function parseOAuthForm(request: Request): Promise<URLSearchParams | Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > oauthBodyLimit) {
    return oauthError("invalid_request", "request body too large", 413);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    !== "application/x-www-form-urlencoded") {
    return oauthError("invalid_request", "form encoding required");
  }

  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > oauthBodyLimit) {
      await reader.cancel().catch(() => undefined);
      return oauthError("invalid_request", "request body too large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

export function rejectDuplicateParameters(form: URLSearchParams, names: readonly string[]): Response | null {
  return names.some((name) => form.getAll(name).length > 1)
    ? oauthError("invalid_request", "duplicate parameter")
    : null;
}

export const oauthRoutes = new Hono<{ Bindings: Env }>();

oauthRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
});

oauthRoutes.get("/.well-known/openid-configuration", (c) => c.json({
  issuer: c.env.ISSUER,
  authorization_endpoint: `${c.env.ISSUER}/authorize`,
  token_endpoint: `${c.env.ISSUER}/token`,
  device_authorization_endpoint: `${c.env.ISSUER}/device/code`,
  jwks_uri: `${c.env.ISSUER}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
  code_challenge_methods_supported: ["S256"],
  subject_types_supported: ["public", "pairwise"],
  id_token_signing_alg_values_supported: ["ES256"],
}));

oauthRoutes.get("/.well-known/jwks.json", async (c) => c.json({ keys: [await publicJwk(c.env)] }));

oauthRoutes.get("/authorize", async (c) => {
  const q = c.req.query();
  if (q.provider !== "github") return oauthError("invalid_request", "unsupported provider");
  if (!q.client_id || !q.redirect_uri || !q.state || !q.code_challenge) {
    return oauthError("invalid_request", "client_id, redirect_uri, state and code_challenge are required");
  }
  if (q.response_type !== "code") return oauthError("unsupported_response_type");
  if (q.code_challenge_method !== "S256" || !validatePkceChallenge(q.code_challenge)) {
    return oauthError("invalid_request", "valid S256 PKCE is required");
  }
  if (q.client_id.length > clientIdLimit || q.redirect_uri.length > redirectUriLimit || q.state.length > 512) {
    return oauthError("invalid_request", "authorization parameter is too long");
  }
  try {
    parseScope(q.scope);
  } catch {
    return oauthError("invalid_scope");
  }
  const client = await getClient(c.env.DB, q.client_id);
  if (!client) return oauthError("unauthorized_client");
  try {
    validateClient(client, q.redirect_uri, "github");
  } catch (error) {
    return oauthError("invalid_request", (error as Error).message);
  }

  const request = randomToken();
  await c.env.DB.prepare(`INSERT INTO consent_requests
    (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, 'github', ?, '["openid"]', ?, ?)`).bind(
      await sha256(request), q.client_id, q.redirect_uri, q.state, q.code_challenge, now() + 600, now(),
    ).run();
  return c.redirect(`${c.env.ISSUER}/consent/?request=${encodeURIComponent(request)}`, 302);
});

oauthRoutes.get("/api/consent/:request", async (c) => {
  const requestHash = await sha256(c.req.param("request"));
  const row = await c.env.DB.prepare(`SELECT r.provider, r.scopes, c.name AS client_name
    FROM consent_requests r JOIN clients c ON c.client_id = r.client_id
    WHERE r.request_hash = ? AND r.expires_at > unixepoch()`)
    .bind(requestHash).first<{ provider: string; scopes: string; client_name: string }>();
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  const csrfToken = await createCsrfToken(c.env.DB, consentPurpose(requestHash));
  return c.json({
    client_name: row.client_name,
    provider: row.provider,
    scopes: JSON.parse(row.scopes),
    csrf_token: csrfToken,
  });
});

oauthRoutes.post("/api/consent/:request/approve", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) return originError;
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) return form;
  const authorized = await requireConsentMutation(
    c.env.DB,
    c.req.param("request"),
    form.get("csrf_token") ?? "",
  );
  if (authorized instanceof Response) return authorized;
  const row = await consumeConsentRequest(c.env.DB, authorized);
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  const upstreamState = randomToken();
  const start = startProvider(c.env, upstreamState);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, redirect_uri, app_state, provider, code_challenge, expires_at, created_at)
    VALUES (?, 'authorization_code', ?, ?, ?, 'github', ?, ?, ?)`).bind(
      await sha256(upstreamState), row.client_id, row.redirect_uri, row.app_state,
      row.code_challenge, now() + 600, now(),
    ).run();
  return c.json({ redirect_to: start.url });
});

oauthRoutes.post("/api/consent/:request/deny", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) return originError;
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) return form;
  const authorized = await requireConsentMutation(
    c.env.DB,
    c.req.param("request"),
    form.get("csrf_token") ?? "",
  );
  if (authorized instanceof Response) return authorized;
  const row = await consumeConsentRequest(c.env.DB, authorized);
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  const target = new URL(row.redirect_uri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("state", row.app_state);
  return c.json({ redirect_to: target.toString() });
});

oauthRoutes.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider");
  const state = c.req.query("state");
  const providerError = c.req.query("error");
  const code = c.req.query("code");
  const denied = providerError === "access_denied";
  if (provider !== "github" || !state || (providerError && !denied) || (!denied && !code)) {
    return oauthError("invalid_request");
  }
  const tx = await consumeTransaction(c.env.DB, await sha256(state));
  if (!tx || tx.provider !== "github") return oauthError("invalid_grant", "expired or invalid state");

  if (denied) {
    if (tx.kind === "device") {
      if (!tx.device_code_hash || !(await denyDeviceGrant(c.env.DB, tx.device_code_hash))) {
        return oauthError("invalid_grant", "device request expired");
      }
      return c.html("<!doctype html><meta charset=utf-8><title>Denied</title><h1>Denied</h1><p>You can return to your device.</p>");
    }
    if (tx.kind === "authorization_code") {
      if (!tx.redirect_uri || !tx.app_state) return oauthError("server_error", undefined, 500);
      const target = new URL(tx.redirect_uri);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("state", tx.app_state);
      return c.redirect(target.toString(), 302);
    }
    return oauthError("access_denied");
  }

  const identity = await finishProvider(c.env, code!);
  const accountId = await resolveIdentity(c.env.DB, identity);
  const providerSub = `${identity.provider}:${identity.id}`;
  const session = randomToken();
  await c.env.DB.prepare("INSERT INTO browser_sessions (session_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(session), accountId, now() + 60 * 60 * 24 * 30, now()).run();
  setCookie(c, "triad_session", session, {
    httpOnly: true,
    secure: c.env.ISSUER.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  if (tx.kind === "session") return c.redirect(`${c.env.ISSUER}/me/`, 302);
  if (tx.kind === "device") {
    if (!tx.device_code_hash
      || !(await approveDeviceGrant(c.env.DB, tx.device_code_hash, accountId, providerSub))) {
      return oauthError("invalid_grant", "device request expired");
    }
    return c.html("<!doctype html><meta charset=utf-8><title>Authorized</title><h1>Authorized</h1><p>You can return to your device.</p>");
  }

  if (!tx.redirect_uri || !tx.code_challenge) return oauthError("server_error", undefined, 500);
  const authCode = randomToken();
  await c.env.DB.prepare(`INSERT INTO authorization_codes
    (code_hash, client_id, redirect_uri, account_id, provider_sub, code_challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      await sha256(authCode), tx.client_id, tx.redirect_uri, accountId, providerSub, tx.code_challenge, now() + 120,
    ).run();
  const target = new URL(tx.redirect_uri);
  target.searchParams.set("code", authCode);
  if (tx.app_state) target.searchParams.set("state", tx.app_state);
  return c.redirect(target.toString(), 302);
});

oauthRoutes.post("/token", async (c) => {
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) return form;
  const duplicateError = rejectDuplicateParameters(form, [
    "grant_type",
    "client_id",
    "code",
    "code_verifier",
    "redirect_uri",
    "device_code",
  ]);
  if (duplicateError) return duplicateError;
  const grantType = form.get("grant_type") ?? "";
  const clientId = form.get("client_id") ?? "";
  const client = clientId && clientId.length <= clientIdLimit ? await getClient(c.env.DB, clientId) : null;
  if (!client) {
    return oauthError("invalid_client");
  }

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    if (!code || code.length > authorizationCodeLimit
      || !validatePkceVerifier(verifier)
      || !redirectUri || redirectUri.length > redirectUriLimit) {
      return oauthError("invalid_grant");
    }
    const codeHash = await sha256(code);
    const candidate = await getAuthorizationCode(c.env.DB, codeHash, clientId, redirectUri);
    if (!candidate || !timingSafeEqual(await sha256(verifier), candidate.code_challenge)) {
      return oauthError("invalid_grant");
    }
    const row = await consumeAuthorizationCode(c.env.DB, codeHash, clientId, redirectUri);
    if (!row) return oauthError("invalid_grant");
    await rememberConsent(c.env.DB, row.account_id, clientId);
    return c.json({
      token_type: "Bearer",
      expires_in: 600,
      id_token: await issueIdToken(c.env, clientId, row.account_id, row.provider_sub),
    });
  }

  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    try {
      validateClient(client, null, "github");
    } catch {
      return oauthError("invalid_client");
    }
    const deviceCode = form.get("device_code") ?? "";
    if (!deviceCode || deviceCode.length > deviceCodeLimit) return oauthError("invalid_grant");
    const hash = await sha256(deviceCode);
    for (let attempt = 0; attempt < 2; attempt++) {
      const approved = await consumeApprovedDeviceGrant(c.env.DB, hash, clientId);
      if (approved) {
        await rememberConsent(c.env.DB, approved.account_id, clientId);
        return c.json({
          token_type: "Bearer",
          expires_in: 600,
          id_token: await issueIdToken(c.env, clientId, approved.account_id, approved.provider_sub),
        });
      }

      const state = await getDeviceGrantState(c.env.DB, hash);
      if (!state || state.client_id !== clientId) return oauthError("invalid_grant");
      if (state.expires_at <= now()) return oauthError("expired_token");
      if (state.consumed_at || state.status === "approved") return oauthError("invalid_grant");
      if (state.status === "denied") return oauthError("access_denied");
      const polling = await pollPendingDeviceGrant(c.env.DB, hash, clientId);
      if (polling) return oauthError(polling);
    }
    return oauthError("invalid_grant");
  }

  return oauthError("unsupported_grant_type");
});

oauthRoutes.onError((error, c) => {
  console.error(error);
  return c.json({ error: "server_error" }, 500, { "cache-control": "no-store", pragma: "no-cache" });
});
