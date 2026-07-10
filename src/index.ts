import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { makeUserCode, normalizeUserCode, randomToken, sha256 } from "./crypto";
import { getClient, validateClient } from "./db";
import { startProvider } from "./providers";
import { oauthError, oauthRoutes } from "./routes/oauth";
import { securityHeaders } from "./security";
import type { Env, ProviderName } from "./types";

const app = new Hono<{ Bindings: Env }>();
const now = () => Math.floor(Date.now() / 1000);
const providers = new Set<ProviderName>(["github"]);

app.use("*", securityHeaders());
app.route("/", oauthRoutes);

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
  try {
    validateClient(client, null, provider);
  } catch (error) {
    return oauthError("invalid_request", (error as Error).message);
  }
  const upstreamState = randomToken();
  const start = startProvider(c.env, upstreamState);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, device_code_hash, expires_at, created_at)
    VALUES (?, 'device', ?, 'github', ?, ?, ?)`).bind(
      await sha256(upstreamState), grant.client_id, grant.device_code_hash, now() + 600, now(),
    ).run();
  return c.redirect(start.url, 302);
});

app.get("/session/start/:provider", async (c) => {
  const provider = c.req.param("provider") as ProviderName;
  if (!providers.has(provider)) return oauthError("invalid_request", "unsupported provider");
  const state = randomToken();
  const start = startProvider(c.env, state);
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, expires_at, created_at)
    VALUES (?, 'session', 'triad-account', 'github', ?, ?)`).bind(
      await sha256(state), now() + 600, now(),
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

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "server_error" }, 500);
});

export default app;
