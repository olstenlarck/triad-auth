import { Hono } from "hono";
import { makeUserCode, normalizeUserCode, randomToken, sha256 } from "../crypto";
import { getClient, validateClient } from "../db";
import { startProvider } from "../providers";
import { createPreAuthBinding, setPreAuthCookie } from "../pre-auth";
import { parseScope } from "../protocol";
import { enforceRequestRateLimit } from "../rate-limit";
import { oauthError, parseOAuthForm, rejectDuplicateParameters, requireSameOrigin } from "./oauth";
import { consumeCsrfToken, createCsrfToken } from "../security";
import type { Env } from "../types";

const now = () => Math.floor(Date.now() / 1000);
const clientIdLimit = 128;
const userCodeInputLimit = 32;
const providerLimit = 32;
const userCodeAttempts = 5;
const userCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;
const devicePurpose = (deviceCodeHash: string) => `device:${deviceCodeHash}`;

function validUserCode(value: string): string | null {
  if (!value || value.length > userCodeInputLimit) return null;
  const normalized = normalizeUserCode(value);
  return userCodePattern.test(normalized) ? normalized : null;
}

export const deviceRoutes = new Hono<{ Bindings: Env }>();

deviceRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
});

deviceRoutes.post("/device/code", async (c) => {
  if (!(await enforceRequestRateLimit(c.env.DB, c.req.raw, c.env.PAIRWISE_SECRET, "device-issue", 10))) {
    return oauthError("temporarily_unavailable", undefined, 429);
  }
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) return form;
  const duplicateError = rejectDuplicateParameters(form, ["client_id", "provider", "scope"]);
  if (duplicateError) return duplicateError;
  const clientId = form.get("client_id") ?? "";
  if (!clientId || clientId.length > clientIdLimit) return oauthError("invalid_client");
  const provider = form.get("provider");
  if (provider && (provider.length > providerLimit || provider !== "github")) {
    return oauthError("invalid_request", "unsupported provider");
  }
  try {
    parseScope(form.get("scope") ?? undefined);
  } catch {
    return oauthError("invalid_scope");
  }
  const client = await getClient(c.env.DB, clientId);
  if (!client) return oauthError("invalid_client");
  try {
    validateClient(client, null, "github");
  } catch (error) {
    return oauthError("unauthorized_client", (error as Error).message);
  }

  const deviceCode = randomToken(32);
  const deviceCodeHash = await sha256(deviceCode);
  let userCode = "";
  let inserted = false;
  for (let attempt = 0; attempt < userCodeAttempts; attempt++) {
    userCode = makeUserCode();
    const normalized = normalizeUserCode(userCode);
    const result = await c.env.DB.prepare(`INSERT OR IGNORE INTO device_grants
      (device_code_hash, user_code, client_id, status, expires_at, interval_seconds, created_at)
      VALUES (?, ?, ?, 'pending', ?, 5, ?)`).bind(
        deviceCodeHash, normalized, clientId, now() + 600, now(),
      ).run();
    if (result.meta.changes === 1) {
      inserted = true;
      break;
    }
    const collision = await c.env.DB.prepare("SELECT 1 FROM device_grants WHERE user_code = ?")
      .bind(normalized).first();
    if (!collision) return oauthError("server_error", undefined, 500);
  }
  if (!inserted) return oauthError("server_error", undefined, 500);
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${c.env.ISSUER}/device/verify`,
    verification_uri_complete: `${c.env.ISSUER}/device/verify?user_code=${encodeURIComponent(userCode)}`,
    expires_in: 600,
    interval: 5,
  });
});

deviceRoutes.get("/device/verify", (c) => c.env.ASSETS.fetch(c.req.raw));

deviceRoutes.get("/api/device/:code", async (c) => {
  if (!(await enforceRequestRateLimit(c.env.DB, c.req.raw, c.env.PAIRWISE_SECRET, "device-inspect", 30))) {
    return oauthError("temporarily_unavailable", undefined, 429);
  }
  const code = validUserCode(c.req.param("code"));
  if (!code) return oauthError("invalid_grant", "That device code is invalid or expired.", 404);
  const row = await c.env.DB.prepare(`SELECT d.device_code_hash, d.client_id, c.name AS client_name, d.expires_at
    FROM device_grants d JOIN clients c ON c.client_id = d.client_id
    WHERE d.user_code = ? AND d.status = 'pending' AND d.expires_at > unixepoch()`)
    .bind(code).first<{ device_code_hash: string; client_id: string; client_name: string; expires_at: number }>();
  if (!row) return oauthError("invalid_grant", "That device code is invalid or expired.", 404);
  const client = await getClient(c.env.DB, row.client_id);
  if (!client) return oauthError("unauthorized_client", undefined, 404);
  try {
    validateClient(client, null, "github");
  } catch (error) {
    return oauthError("unauthorized_client", (error as Error).message, 404);
  }
  return c.json({
    client_name: row.client_name,
    expires_in: row.expires_at - now(),
    csrf_token: await createCsrfToken(c.env.DB, devicePurpose(row.device_code_hash)),
  });
});

deviceRoutes.post("/device/verify", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) return originError;
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) return form;
  const duplicateError = rejectDuplicateParameters(form, ["user_code", "provider", "csrf_token"]);
  if (duplicateError) return duplicateError;
  const userCode = validUserCode(form.get("user_code") ?? "");
  const provider = form.get("provider") ?? "";
  if (!userCode) return oauthError("invalid_grant", "invalid or expired user code");
  if (!provider || provider.length > providerLimit || provider !== "github") {
    return oauthError("invalid_request", "unsupported provider");
  }
  const grant = await c.env.DB.prepare(`SELECT device_code_hash, client_id FROM device_grants
    WHERE user_code = ? AND status = 'pending' AND expires_at > unixepoch()`)
    .bind(userCode).first<{ device_code_hash: string; client_id: string }>();
  if (!grant) return oauthError("invalid_grant", "invalid or expired user code");
  const client = await getClient(c.env.DB, grant.client_id);
  if (!client) return oauthError("unauthorized_client");
  try {
    validateClient(client, null, "github");
  } catch (error) {
    return oauthError("unauthorized_client", (error as Error).message);
  }
  if (!(await consumeCsrfToken(
    c.env.DB,
    form.get("csrf_token") ?? "",
    devicePurpose(grant.device_code_hash),
  ))) {
    return oauthError("invalid_request", "invalid CSRF token", 403);
  }

  const upstreamState = randomToken();
  const stateHash = await sha256(upstreamState);
  const start = startProvider(c.env, upstreamState);
  const binding = await createPreAuthBinding();
  await c.env.DB.prepare(`INSERT INTO oauth_transactions
    (state_hash, kind, client_id, provider, device_code_hash, browser_binding_hash, expires_at, created_at)
    VALUES (?, 'device', ?, 'github', ?, ?, ?, ?)`).bind(
      stateHash, grant.client_id, grant.device_code_hash, binding.hash, now() + 600, now(),
    ).run();
  setPreAuthCookie(c, stateHash, binding.token);
  return c.json({ redirect_to: start.url });
});

deviceRoutes.onError((_error, c) => {
  console.error("device route failed");
  return c.json({ error: "server_error" }, 500, { "cache-control": "no-store", pragma: "no-cache" });
});
