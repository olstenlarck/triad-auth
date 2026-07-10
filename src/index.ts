import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { makeUserCode, normalizeUserCode, randomToken, sha256, timingSafeEqual } from "./crypto";
import { consumeTransaction, getClient, resolveIdentity, validateClient } from "./db";
import { finishProvider, startProvider } from "./providers";
import { issueIdToken, publicJwk } from "./tokens";
import type { Env, ProviderName } from "./types";

const app = new Hono<{ Bindings: Env }>();
const now = () => Math.floor(Date.now() / 1000);
const providers = new Set<ProviderName>(["google", "github", "x"]);
const oauthError = (error: string, description?: string, status = 400) =>
  new Response(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
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

async function consumeConsentRequest(db: D1Database, request: string): Promise<ConsentRequestRow | null> {
  const hash = await sha256(request);
  const row = await db.prepare("SELECT * FROM consent_requests WHERE request_hash = ? AND expires_at > unixepoch()")
    .bind(hash).first<ConsentRequestRow>();
  if (!row) return null;
  const consumed = await db.prepare("DELETE FROM consent_requests WHERE request_hash = ?").bind(hash).run();
  return consumed.meta.changes === 1 ? row : null;
}

async function rememberConsent(db: D1Database, accountId: string, clientId: string): Promise<void> {
  await db.prepare(`INSERT INTO consents (account_id, client_id, scopes, updated_at)
    VALUES (?, ?, '["openid"]', unixepoch())
    ON CONFLICT(account_id, client_id) DO UPDATE SET scopes = excluded.scopes, updated_at = excluded.updated_at`)
    .bind(accountId, clientId).run();
}

app.get("/.well-known/openid-configuration", (c) => c.json({
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

app.get("/.well-known/jwks.json", async (c) => c.json({ keys: [await publicJwk(c.env)] }));

app.get("/authorize", async (c) => {
  const q = c.req.query();
  const provider = q.provider as ProviderName;
  if (!providers.has(provider)) return oauthError("invalid_request", "unsupported provider");
  if (!q.client_id || !q.redirect_uri || !q.state || !q.code_challenge) {
    return oauthError("invalid_request", "client_id, redirect_uri, state and code_challenge are required");
  }
  if (q.response_type !== "code") return oauthError("unsupported_response_type");
  if (q.code_challenge_method !== "S256") return oauthError("invalid_request", "S256 PKCE is required");
  const client = await getClient(c.env.DB, q.client_id);
  if (!client) return oauthError("unauthorized_client");
  try { validateClient(client, q.redirect_uri, provider); } catch (error) {
    return oauthError("invalid_request", (error as Error).message);
  }

  const request = randomToken();
  await c.env.DB.prepare(`INSERT INTO consent_requests
    (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '["openid"]', ?, ?)`).bind(
      await sha256(request), q.client_id, q.redirect_uri, q.state, provider,
      q.code_challenge, now() + 600, now(),
    ).run();
  return c.redirect(`${c.env.ISSUER}/consent/?request=${encodeURIComponent(request)}`, 302);
});

app.get("/api/consent/:request", async (c) => {
  const hash = await sha256(c.req.param("request"));
  const row = await c.env.DB.prepare(`SELECT r.provider, r.scopes, c.name AS client_name
    FROM consent_requests r JOIN clients c ON c.client_id = r.client_id
    WHERE r.request_hash = ? AND r.expires_at > unixepoch()`)
    .bind(hash).first<{ provider: string; scopes: string; client_name: string }>();
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  return c.json({ client_name: row.client_name, provider: row.provider, scopes: JSON.parse(row.scopes) });
});

app.post("/api/consent/:request/approve", async (c) => {
  const row = await consumeConsentRequest(c.env.DB, c.req.param("request"));
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  const upstreamState = randomToken();
  const start = await startProvider(row.provider, c.env, upstreamState);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, redirect_uri, app_state, provider, code_challenge, provider_verifier, provider_nonce, expires_at, created_at)
    VALUES (?, 'authorization_code', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      await sha256(upstreamState), row.client_id, row.redirect_uri, row.app_state, row.provider,
      row.code_challenge, start.verifier ?? null, start.nonce ?? null, now() + 600, now(),
    ).run();
  return c.json({ redirect_to: start.url });
});

app.post("/api/consent/:request/deny", async (c) => {
  const row = await consumeConsentRequest(c.env.DB, c.req.param("request"));
  if (!row) return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  const target = new URL(row.redirect_uri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("state", row.app_state);
  return c.json({ redirect_to: target.toString() });
});

app.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as ProviderName;
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!providers.has(provider) || !state || !code) return oauthError("invalid_request");
  const tx = await consumeTransaction(c.env.DB, await sha256(state));
  if (!tx || tx.provider !== provider) return oauthError("invalid_grant", "expired or invalid state");

  const identity = await finishProvider(provider, c.env, code, tx.provider_verifier, tx.provider_nonce);
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
    const result = await c.env.DB.prepare(`UPDATE device_grants SET status = 'approved', account_id = ?, provider_sub = ?
      WHERE device_code_hash = ? AND status = 'pending' AND expires_at > unixepoch()`)
      .bind(accountId, providerSub, tx.device_code_hash).run();
    if (result.meta.changes !== 1) return oauthError("invalid_grant", "device request expired");
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

app.post("/device/code", async (c) => {
  const form = await c.req.parseBody();
  const clientId = String(form.client_id ?? "");
  const client = await getClient(c.env.DB, clientId);
  if (!client) return oauthError("unauthorized_client");
  const deviceCode = randomToken(32);
  const userCode = makeUserCode();
  await c.env.DB.prepare(`INSERT INTO device_grants
    (device_code_hash, user_code, client_id, status, expires_at, interval_seconds, created_at)
    VALUES (?, ?, ?, 'pending', ?, 5, ?)`).bind(
      await sha256(deviceCode), normalizeUserCode(userCode), clientId, now() + 600, now(),
    ).run();
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${c.env.ISSUER}/device/verify`,
    verification_uri_complete: `${c.env.ISSUER}/device/verify?user_code=${encodeURIComponent(userCode)}`,
    expires_in: 600,
    interval: 5,
  });
});

app.get("/device/verify", (c) => c.env.ASSETS.fetch(c.req.raw));

app.get("/api/device/:code", async (c) => {
  const code = normalizeUserCode(c.req.param("code"));
  const row = await c.env.DB.prepare(`SELECT c.name AS client_name, d.expires_at
    FROM device_grants d JOIN clients c ON c.client_id = d.client_id
    WHERE d.user_code = ? AND d.status = 'pending' AND d.expires_at > unixepoch()`)
    .bind(code).first<{ client_name: string; expires_at: number }>();
  if (!row) return oauthError("invalid_grant", "That device code is invalid or expired.", 404);
  return c.json({ client_name: row.client_name, expires_in: row.expires_at - now() });
});

app.post("/device/verify", async (c) => {
  const form = await c.req.parseBody();
  const userCode = normalizeUserCode(String(form.user_code ?? ""));
  const provider = String(form.provider ?? "") as ProviderName;
  if (!providers.has(provider)) return oauthError("invalid_request", "unsupported provider");
  const grant = await c.env.DB.prepare(`SELECT device_code_hash, client_id FROM device_grants
    WHERE user_code = ? AND status = 'pending' AND expires_at > unixepoch()`)
    .bind(userCode).first<{ device_code_hash: string; client_id: string }>();
  if (!grant) return oauthError("invalid_grant", "invalid or expired user code");
  const client = await getClient(c.env.DB, grant.client_id);
  if (!client) return oauthError("unauthorized_client");
  try { validateClient(client, null, provider); } catch (error) {
    return oauthError("invalid_request", (error as Error).message);
  }
  const upstreamState = randomToken();
  const start = await startProvider(provider, c.env, upstreamState);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, provider_verifier, provider_nonce, device_code_hash, expires_at, created_at)
    VALUES (?, 'device', ?, ?, ?, ?, ?, ?, ?)`).bind(
      await sha256(upstreamState), grant.client_id, provider, start.verifier ?? null, start.nonce ?? null,
      grant.device_code_hash, now() + 600, now(),
    ).run();
  return c.redirect(start.url, 302);
});

app.get("/session/start/:provider", async (c) => {
  const provider = c.req.param("provider") as ProviderName;
  if (!providers.has(provider)) return oauthError("invalid_request", "unsupported provider");
  const state = randomToken();
  const start = await startProvider(provider, c.env, state);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, provider_verifier, provider_nonce, expires_at, created_at)
    VALUES (?, 'session', 'triad-account', ?, ?, ?, ?, ?)`).bind(
      await sha256(state), provider, start.verifier ?? null, start.nonce ?? null, now() + 600, now(),
    ).run();
  return c.redirect(start.url, 302);
});

app.get("/api/me", async (c) => {
  const token = getCookie(c, "triad_session");
  if (!token) return oauthError("login_required", undefined, 401);
  const session = await c.env.DB.prepare("SELECT account_id FROM browser_sessions WHERE session_hash = ? AND expires_at > unixepoch()")
    .bind(await sha256(token)).first<{ account_id: string }>();
  if (!session) return oauthError("login_required", undefined, 401);
  const identities = await c.env.DB.prepare("SELECT provider, provider_user_id FROM identities WHERE account_id = ? ORDER BY created_at")
    .bind(session.account_id).all<{ provider: string; provider_user_id: string }>();
  const clients = await c.env.DB.prepare(`SELECT c.client_id, c.name, x.updated_at
    FROM consents x JOIN clients c ON c.client_id = x.client_id
    WHERE x.account_id = ? AND c.client_id != 'triad-account' ORDER BY x.updated_at DESC`)
    .bind(session.account_id).all<{ client_id: string; name: string; updated_at: number }>();
  return c.json({
    account_sub: session.account_id,
    identities: identities.results.map((row) => `${row.provider}:${row.provider_user_id}`),
    clients: clients.results,
  });
});

app.delete("/api/me/clients/:clientId", async (c) => {
  const token = getCookie(c, "triad_session");
  if (!token) return oauthError("login_required", undefined, 401);
  const session = await c.env.DB.prepare("SELECT account_id FROM browser_sessions WHERE session_hash = ? AND expires_at > unixepoch()")
    .bind(await sha256(token)).first<{ account_id: string }>();
  if (!session) return oauthError("login_required", undefined, 401);
  const result = await c.env.DB.prepare("DELETE FROM consents WHERE account_id = ? AND client_id = ?")
    .bind(session.account_id, c.req.param("clientId")).run();
  return result.meta.changes === 1 ? c.body(null, 204) : oauthError("invalid_request", "Authorization not found.", 404);
});

app.post("/token", async (c) => {
  const form = await c.req.parseBody();
  const grantType = String(form.grant_type ?? "");
  const clientId = String(form.client_id ?? "");
  if (!(await getClient(c.env.DB, clientId))) return oauthError("unauthorized_client");

  if (grantType === "authorization_code") {
    const code = String(form.code ?? "");
    const verifier = String(form.code_verifier ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    const codeHash = await sha256(code);
    const row = await c.env.DB.prepare(`SELECT account_id, provider_sub, code_challenge FROM authorization_codes
      WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > unixepoch()`)
      .bind(codeHash, clientId, redirectUri).first<{ account_id: string; provider_sub: string; code_challenge: string }>();
    if (!row || !timingSafeEqual(await sha256(verifier), row.code_challenge)) return oauthError("invalid_grant");
    const consumed = await c.env.DB.prepare("UPDATE authorization_codes SET consumed_at = unixepoch() WHERE code_hash = ? AND consumed_at IS NULL")
      .bind(codeHash).run();
    if (consumed.meta.changes !== 1) return oauthError("invalid_grant");
    await rememberConsent(c.env.DB, row.account_id, clientId);
    return c.json({ token_type: "Bearer", expires_in: 600, id_token: await issueIdToken(c.env, clientId, row.account_id, row.provider_sub) });
  }

  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    const hash = await sha256(String(form.device_code ?? ""));
    const row = await c.env.DB.prepare("SELECT * FROM device_grants WHERE device_code_hash = ? AND client_id = ?")
      .bind(hash, clientId).first<{ status: string; account_id: string | null; provider_sub: string | null; expires_at: number; interval_seconds: number; last_polled_at: number | null; consumed_at: number | null }>();
    if (!row || row.expires_at <= now()) return oauthError("expired_token");
    if (row.last_polled_at && now() - row.last_polled_at < row.interval_seconds) {
      await c.env.DB.prepare("UPDATE device_grants SET interval_seconds = interval_seconds + 5, last_polled_at = unixepoch() WHERE device_code_hash = ?").bind(hash).run();
      return oauthError("slow_down");
    }
    await c.env.DB.prepare("UPDATE device_grants SET last_polled_at = unixepoch() WHERE device_code_hash = ?").bind(hash).run();
    if (row.status === "pending") return oauthError("authorization_pending");
    if (row.status === "denied") return oauthError("access_denied");
    if (row.consumed_at || !row.account_id || !row.provider_sub) return oauthError("invalid_grant");
    const consumed = await c.env.DB.prepare("UPDATE device_grants SET consumed_at = unixepoch() WHERE device_code_hash = ? AND consumed_at IS NULL")
      .bind(hash).run();
    if (consumed.meta.changes !== 1) return oauthError("invalid_grant");
    await rememberConsent(c.env.DB, row.account_id, clientId);
    return c.json({ token_type: "Bearer", expires_in: 600, id_token: await issueIdToken(c.env, clientId, row.account_id, row.provider_sub) });
  }

  return oauthError("unsupported_grant_type");
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "server_error" }, 500);
});

export default app;
