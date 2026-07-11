import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { providerSubject, randomToken, sha256 } from "../crypto";
import { cleanupExpiredState } from "../cleanup";
import { createPreAuthBinding, setPreAuthCookie } from "../pre-auth";
import { enabledProviders, startProvider } from "../providers";
import { enforceRequestRateLimit } from "../rate-limit";
import { consumeCsrfToken, createCsrfToken } from "../security";
import type { Env, ProviderName } from "../types";
import { oauthError, parseOAuthForm, rejectDuplicateParameters, requireSameOrigin } from "./oauth";

const now = () => Math.floor(Date.now() / 1000);
const providers = new Set<ProviderName>(["google", "github", "twitter"]);
const clientIdLimit = 128;

interface BrowserSession {
  accountId: string;
  sessionHash: string;
}

const accountPurpose = (sessionHash: string) => `account:${sessionHash}`;

async function requireSession(db: D1Database, token?: string): Promise<BrowserSession | null> {
  if (!token) return null;
  const sessionHash = await sha256(token);
  const row = await db
    .prepare(
      `SELECT account_id FROM browser_sessions
    WHERE session_hash = ? AND expires_at > unixepoch()`,
    )
    .bind(sessionHash)
    .first<{ account_id: string }>();
  return row ? { accountId: row.account_id, sessionHash } : null;
}

async function authorizeMutation(
  db: D1Database,
  session: BrowserSession,
  request: Request,
): Promise<Response | null> {
  const form = await parseOAuthForm(request);
  if (form instanceof Response) return form;
  const duplicateError = rejectDuplicateParameters(form, ["csrf_token"]);
  if (duplicateError) return duplicateError;
  return (await consumeCsrfToken(db, form.get("csrf_token") ?? "", accountPurpose(session.sessionHash)))
    ? null
    : oauthError("invalid_request", "invalid CSRF token", 403);
}

export const accountRoutes = new Hono<{ Bindings: Env }>();

accountRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
});

accountRoutes.get("/session/start/:provider", async (c) => {
  if (!(await enforceRequestRateLimit(c.env.DB, c.req.raw, c.env.PAIRWISE_SECRET, "session-start", 10))) {
    return oauthError("temporarily_unavailable", undefined, 429);
  }
  const provider = c.req.param("provider") as ProviderName;
  if (!providers.has(provider)) return oauthError("invalid_request", "unsupported provider");
  if (!enabledProviders(c.env).includes(provider))
    return oauthError("invalid_request", "provider unavailable");
  const state = randomToken();
  const stateHash = await sha256(state);
  const start = await startProvider(provider, c.env, state, ["openid"]);
  const binding = await createPreAuthBinding();
  await cleanupExpiredState(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, provider_verifier, provider_nonce,
      scopes, browser_binding_hash, expires_at, created_at)
    VALUES (?, 'session', 'triad-account', ?, ?, ?, '["openid"]', ?, ?, ?)`,
  )
    .bind(stateHash, provider, start.verifier ?? null, start.nonce ?? null, binding.hash, now() + 600, now())
    .run();
  setPreAuthCookie(c, stateHash, binding.token, provider);
  return c.redirect(start.url, 302);
});

accountRoutes.get("/api/me", async (c) => {
  const session = await requireSession(c.env.DB, getCookie(c, "triad_session"));
  if (!session) return oauthError("login_required", undefined, 401);
  const identities = await c.env.DB.prepare(
    `SELECT provider, provider_user_id FROM identities
    WHERE account_id = ? ORDER BY created_at`,
  )
    .bind(session.accountId)
    .all<{ provider: string; provider_user_id: string }>();
  const clients = await c.env.DB.prepare(
    `SELECT c.client_id, c.name, x.updated_at
    FROM consents x JOIN clients c ON c.client_id = x.client_id
    WHERE x.account_id = ? AND c.client_id != 'triad-account' ORDER BY x.updated_at DESC`,
  )
    .bind(session.accountId)
    .all<{ client_id: string; name: string; updated_at: number }>();
  const providerSubs = await Promise.all(
    identities.results.map((row) =>
      providerSubject(c.env.PAIRWISE_SECRET, row.provider as ProviderName, row.provider_user_id),
    ),
  );
  return c.json({
    account_sub: session.accountId,
    identities: providerSubs,
    clients: clients.results,
    csrf_token: await createCsrfToken(c.env.DB, accountPurpose(session.sessionHash)),
  });
});

accountRoutes.delete("/api/me/clients/:clientId", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) return originError;
  const session = await requireSession(c.env.DB, getCookie(c, "triad_session"));
  if (!session) return oauthError("login_required", undefined, 401);
  const authorizationError = await authorizeMutation(c.env.DB, session, c.req.raw);
  if (authorizationError) return authorizationError;
  const clientId = c.req.param("clientId");
  if (!clientId || clientId.length > clientIdLimit) {
    return oauthError("invalid_request", "Authorization not found.", 404);
  }
  const result = await c.env.DB.prepare("DELETE FROM consents WHERE account_id = ? AND client_id = ?")
    .bind(session.accountId, clientId)
    .run();
  if (result.meta.changes !== 1) return oauthError("invalid_request", "Authorization not found.", 404);
  return c.json({ csrf_token: await createCsrfToken(c.env.DB, accountPurpose(session.sessionHash)) });
});

accountRoutes.post("/session/logout", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) return originError;
  const session = await requireSession(c.env.DB, getCookie(c, "triad_session"));
  if (!session) return oauthError("login_required", undefined, 401);
  const authorizationError = await authorizeMutation(c.env.DB, session, c.req.raw);
  if (authorizationError) return authorizationError;
  const result = await c.env.DB.prepare("DELETE FROM browser_sessions WHERE session_hash = ?")
    .bind(session.sessionHash)
    .run();
  if (result.meta.changes !== 1) return oauthError("login_required", undefined, 401);
  deleteCookie(c, "triad_session", { path: "/", secure: true, sameSite: "Lax" });
  return c.body(null, 204);
});
