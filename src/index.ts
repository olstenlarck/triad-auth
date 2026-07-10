import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { randomToken, sha256 } from "./crypto";
import { startProvider } from "./providers";
import { deviceRoutes } from "./routes/device";
import { oauthError, oauthRoutes } from "./routes/oauth";
import { securityHeaders } from "./security";
import type { Env, ProviderName } from "./types";

const app = new Hono<{ Bindings: Env }>();
const now = () => Math.floor(Date.now() / 1000);
const providers = new Set<ProviderName>(["github"]);

app.use("*", securityHeaders());
app.route("/", oauthRoutes);
app.route("/", deviceRoutes);

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
