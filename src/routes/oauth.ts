import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { parseScopes, providerScopes, serializeScopes, validateProviderScopes } from "../claims";
import { cleanupExpiredState } from "../cleanup";
import {
  openClaims,
  providerSubject,
  randomToken,
  sealClaims,
  sha256,
  timingSafeEqual,
} from "../crypto";
import {
  approveDeviceGrant,
  clientIdFromRedirect,
  consumeAuthorizationCode,
  consumeApprovedDeviceGrant,
  consumeTransaction,
  denyDeviceGrant,
  getAuthorizationCode,
  getClient,
  getDeviceGrantState,
  getOrCreateOriginClient,
  pollPendingDeviceGrant,
  rememberConsent,
  resolveIdentity,
  validateClient,
} from "../db";
import {
  enabledProviders,
  finishProvider,
  MandatoryProfileValueError,
  startProvider,
} from "../providers";
import {
  clearPreAuthCookie,
  createPreAuthBinding,
  preAuthCookieName,
  setPreAuthCookie,
} from "../pre-auth";
import { validatePkceChallenge, validatePkceVerifier } from "../protocol";
import { enforceRequestRateLimit } from "../rate-limit";
import { assertSameOrigin, consumeCsrfToken, createCsrfToken } from "../security";
import { issueIdToken, publicJwks } from "../tokens";
import type { Env, ProviderName, Scope, TransactionRow } from "../types";

const now = () => Math.floor(Date.now() / 1000);
const browserSessionLifetimeSeconds = 60 * 60 * 24 * 7;
const consentPurpose = (requestHash: string) => `consent:${requestHash}`;
const oauthBodyLimit = 4096;
const clientIdLimit = 128;
const authorizationCodeLimit = 128;
const deviceCodeLimit = 128;
const redirectUriLimit = 2048;
const providerNames = new Set<ProviderName>(["google", "github", "twitter"]);

function parseProvider(value?: string): ProviderName | null {
  return providerNames.has(value as ProviderName) ? (value as ProviderName) : null;
}

function parseStoredScopes(value: string): Scope[] {
  const stored: unknown = JSON.parse(value);
  if (!Array.isArray(stored) || !stored.every((scope) => typeof scope === "string")) {
    throw new Error("invalid stored scopes");
  }
  const scopes = parseScopes(stored.join(" "));
  if (JSON.stringify(scopes) !== JSON.stringify(stored)) {
    throw new Error("invalid stored scopes");
  }

  return scopes;
}

export function oauthError(error: string, description?: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

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

async function consumeConsentRequest(
  db: D1Database,
  requestHash: string,
): Promise<ConsentRequestRow | null> {
  const row = await db
    .prepare("SELECT * FROM consent_requests WHERE request_hash = ? AND expires_at > unixepoch()")
    .bind(requestHash)
    .first<ConsentRequestRow>();
  if (!row) {
    return null;
  }
  const consumed = await db
    .prepare("DELETE FROM consent_requests WHERE request_hash = ?")
    .bind(requestHash)
    .run();

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
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return oauthError("invalid_request", "form encoding required");
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return new URLSearchParams();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
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

export function rejectDuplicateParameters(
  form: URLSearchParams,
  names: readonly string[],
): Response | null {
  return names.some((name) => form.getAll(name).length > 1)
    ? oauthError("invalid_request", "duplicate parameter")
    : null;
}

export const oauthRoutes = new Hono<{ Bindings: Env }>();

async function rotateBrowserSession(
  c: Context<{ Bindings: Env }>,
  accountId: string,
): Promise<void> {
  await cleanupExpiredState(c.env.DB);
  const session = randomToken();
  const oldSession = getCookie(c, "triad_session");
  const statements = [];
  if (oldSession) {
    statements.push(
      c.env.DB.prepare("DELETE FROM browser_sessions WHERE session_hash = ?").bind(
        await sha256(oldSession),
      ),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO browser_sessions
    (session_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(await sha256(session), accountId, now() + browserSessionLifetimeSeconds, now()),
  );
  await c.env.DB.batch(statements);
  setCookie(c, "triad_session", session, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: browserSessionLifetimeSeconds,
  });
}

async function finishAccessDenied(
  c: Context<{ Bindings: Env }>,
  tx: TransactionRow,
): Promise<Response> {
  if (tx.kind === "device") {
    if (!tx.device_code_hash || !(await denyDeviceGrant(c.env.DB, tx.device_code_hash))) {
      return oauthError("invalid_grant", "device request expired");
    }

    return c.html(
      "<!doctype html><meta charset=utf-8><title>Denied</title><h1>Denied</h1><p>You can return to your device.</p>",
    );
  }
  if (tx.kind === "authorization_code") {
    if (!tx.redirect_uri || !tx.app_state) {
      return oauthError("server_error", undefined, 500);
    }
    const target = new URL(tx.redirect_uri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("state", tx.app_state);

    return c.redirect(target.toString(), 302);
  }

  return c.redirect(`${c.env.ISSUER}/me/?error=access_denied`, 302);
}

oauthRoutes.use("/token", async (c, next) => {
  await next();
  await cleanupExpiredState(c.env.DB);
});

oauthRoutes.get("/.well-known/openid-configuration", (c) =>
  c.json({
    issuer: c.env.ISSUER,
    authorization_endpoint: `${c.env.ISSUER}/authorize`,
    token_endpoint: `${c.env.ISSUER}/token`,
    device_authorization_endpoint: `${c.env.ISSUER}/device/code`,
    jwks_uri: `${c.env.ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["pairwise"],
    scopes_supported: ["openid", "email", "handle", "name", "avatar"],
    claims_supported: [
      "sub",
      "pairwise_sub",
      "account_sub",
      "provider_sub",
      "email",
      "email_verified",
      "preferred_username",
      "name",
      "picture",
    ],
    id_token_signing_alg_values_supported: ["ES256"],
  }),
);

oauthRoutes.get("/.well-known/jwks.json", async (c) => c.json({ keys: await publicJwks(c.env) }));

oauthRoutes.get("/api/providers", (c) =>
  c.json({
    providers: enabledProviders(c.env).map((provider) => ({
      id: provider,
      scopes: providerScopes(provider),
    })),
  }),
);

oauthRoutes.get("/authorize", async (c) => {
  if (
    !(await enforceRequestRateLimit(
      c.env.DB,
      c.req.raw,
      c.env.RATE_LIMIT_SECRET,
      "authorization-start",
      20,
    ))
  ) {
    return oauthError("temporarily_unavailable", undefined, 429);
  }
  const q = c.req.query();
  const provider = parseProvider(q.provider);
  if (!provider) {
    return oauthError("invalid_request", "unsupported provider");
  }
  if (!enabledProviders(c.env).includes(provider)) {
    return oauthError("invalid_request", "provider unavailable");
  }
  if (!q.redirect_uri || !q.state || !q.code_challenge) {
    return oauthError("invalid_request", "redirect_uri, state and code_challenge are required");
  }
  if (q.response_type !== "code") {
    return oauthError("unsupported_response_type");
  }
  if (q.code_challenge_method !== "S256" || !validatePkceChallenge(q.code_challenge)) {
    return oauthError("invalid_request", "valid S256 PKCE is required");
  }
  if (
    (q.client_id?.length ?? 0) > clientIdLimit ||
    q.redirect_uri.length > redirectUriLimit ||
    q.state.length > 512
  ) {
    return oauthError("invalid_request", "authorization parameter is too long");
  }
  let scopes: Scope[];
  try {
    scopes = parseScopes(q.scope);
    validateProviderScopes(provider, scopes);
  } catch {
    return oauthError("invalid_scope");
  }
  let clientId: string;
  try {
    const originClientId = clientIdFromRedirect(q.redirect_uri);
    clientId = q.client_id ?? originClientId;

    if (clientId === originClientId) {
      const client = await getOrCreateOriginClient(c.env.DB, clientId);
      validateClient(client, null, provider, c.env.ISSUER);
    } else {
      const client = await getClient(c.env.DB, clientId);
      if (!client) {
        return oauthError("unauthorized_client");
      }
      validateClient(client, q.redirect_uri, provider, c.env.ISSUER);
    }
  } catch (error) {
    return oauthError("invalid_request", (error as Error).message);
  }

  const request = randomToken();
  await cleanupExpiredState(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO consent_requests
    (request_hash, client_id, redirect_uri, app_state, provider, code_challenge, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256(request),
      clientId,
      q.redirect_uri,
      q.state,
      provider,
      q.code_challenge,
      JSON.stringify(scopes),
      now() + 600,
      now(),
    )
    .run();

  return c.redirect(`${c.env.ISSUER}/consent/?request=${encodeURIComponent(request)}`, 302);
});

oauthRoutes.get("/api/consent/:request", async (c) => {
  const requestHash = await sha256(c.req.param("request"));
  const row = await c.env.DB.prepare(
    `SELECT r.client_id, r.provider, r.scopes, c.name AS client_name
    FROM consent_requests r JOIN clients c ON c.client_id = r.client_id
    WHERE r.request_hash = ? AND r.expires_at > unixepoch()`,
  )
    .bind(requestHash)
    .first<{ client_id: string; provider: string; scopes: string; client_name: string }>();
  if (!row) {
    return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  }
  const csrfToken = await createCsrfToken(c.env.DB, consentPurpose(requestHash));

  return c.json({
    client_name: row.client_name,
    client_id: row.client_id,
    provider: row.provider,
    scopes: JSON.parse(row.scopes),
    csrf_token: csrfToken,
  });
});

oauthRoutes.post("/api/consent/:request/approve", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) {
    return originError;
  }
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) {
    return form;
  }
  const authorized = await requireConsentMutation(
    c.env.DB,
    c.req.param("request"),
    form.get("csrf_token") ?? "",
  );
  if (authorized instanceof Response) {
    return authorized;
  }
  const row = await consumeConsentRequest(c.env.DB, authorized);
  if (!row) {
    return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  }
  const scopes = parseStoredScopes(row.scopes);
  const upstreamState = randomToken();
  const stateHash = await sha256(upstreamState);
  const start = await startProvider(row.provider, c.env, upstreamState, scopes);
  const binding = await createPreAuthBinding();
  await cleanupExpiredState(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO oauth_transactions
    (state_hash, kind, client_id, redirect_uri, app_state, provider, code_challenge,
      provider_verifier, provider_nonce, scopes, browser_binding_hash, expires_at, created_at)
    VALUES (?, 'authorization_code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      stateHash,
      row.client_id,
      row.redirect_uri,
      row.app_state,
      row.provider,
      row.code_challenge,
      start.verifier ?? null,
      start.nonce ?? null,
      row.scopes,
      binding.hash,
      now() + 600,
      now(),
    )
    .run();
  setPreAuthCookie(c, stateHash, binding.token, row.provider);

  return c.json({ redirect_to: start.url });
});

oauthRoutes.post("/api/consent/:request/deny", async (c) => {
  const originError = requireSameOrigin(c.req.raw, c.env.ISSUER);
  if (originError) {
    return originError;
  }
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) {
    return form;
  }
  const authorized = await requireConsentMutation(
    c.env.DB,
    c.req.param("request"),
    form.get("csrf_token") ?? "",
  );
  if (authorized instanceof Response) {
    return authorized;
  }
  const row = await consumeConsentRequest(c.env.DB, authorized);
  if (!row) {
    return oauthError("invalid_request", "This authorization request is invalid or expired.", 404);
  }
  const target = new URL(row.redirect_uri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("state", row.app_state);

  return c.json({ redirect_to: target.toString() });
});

oauthRoutes.get("/callback/:provider", async (c) => {
  if (
    !(await enforceRequestRateLimit(
      c.env.DB,
      c.req.raw,
      c.env.RATE_LIMIT_SECRET,
      "provider-callback",
      30,
    ))
  ) {
    return oauthError("temporarily_unavailable", undefined, 429);
  }
  const provider = parseProvider(c.req.param("provider"));
  const state = c.req.query("state");
  const providerError = c.req.query("error");
  const code = c.req.query("code");
  const denied = providerError === "access_denied";
  if (!provider || !state || (providerError && !denied) || (!denied && !code)) {
    return oauthError("invalid_request");
  }
  const stateHash = await sha256(state);
  const browserBinding = getCookie(c, preAuthCookieName(stateHash));
  if (!browserBinding) {
    return oauthError("invalid_grant", "expired or invalid state");
  }
  const tx = await consumeTransaction(c.env.DB, stateHash, await sha256(browserBinding));
  if (!tx || tx.provider !== provider) {
    return oauthError("invalid_grant", "expired or invalid state");
  }
  clearPreAuthCookie(c, stateHash, tx.provider);

  if (denied) {
    return finishAccessDenied(c, tx);
  }

  const scopes = parseStoredScopes(tx.scopes);
  let identity;
  try {
    identity = await finishProvider(
      tx.provider,
      c.env,
      code!,
      tx.provider_verifier ?? undefined,
      tx.provider_nonce ?? undefined,
      scopes,
    );
  } catch (error) {
    if (error instanceof MandatoryProfileValueError) {
      return finishAccessDenied(c, tx);
    }
    throw error;
  }
  const accountId = await resolveIdentity(c.env.DB, identity, c.env.IDENTIFIER_SECRET);
  const providerSub = await providerSubject(
    c.env.IDENTIFIER_SECRET,
    identity.provider,
    identity.id,
  );

  if (tx.kind === "session") {
    await rotateBrowserSession(c, accountId);

    return c.redirect(`${c.env.ISSUER}/me/`, 302);
  }
  if (tx.kind === "device") {
    const claimsCiphertext =
      tx.device_code_hash && identity.claims
        ? await sealClaims(c.env.CLAIMS_ENCRYPTION_KEYRING, tx.device_code_hash, identity.claims)
        : null;
    if (
      !tx.device_code_hash ||
      !(await approveDeviceGrant(
        c.env.DB,
        tx.device_code_hash,
        accountId,
        providerSub,
        claimsCiphertext,
      ))
    ) {
      return oauthError("invalid_grant", "device request expired");
    }
    await rotateBrowserSession(c, accountId);

    return c.html(
      "<!doctype html><meta charset=utf-8><title>Authorized</title><h1>Authorized</h1><p>You can return to your device.</p>",
    );
  }

  if (!tx.redirect_uri || !tx.code_challenge) {
    return oauthError("server_error", undefined, 500);
  }
  const authCode = randomToken();
  const codeHash = await sha256(authCode);
  const claimsCiphertext = identity.claims
    ? await sealClaims(c.env.CLAIMS_ENCRYPTION_KEYRING, codeHash, identity.claims)
    : null;
  await cleanupExpiredState(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO authorization_codes
    (code_hash, client_id, redirect_uri, account_id, provider, provider_sub, code_challenge,
      scopes, claims_ciphertext, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      codeHash,
      tx.client_id,
      tx.redirect_uri,
      accountId,
      tx.provider,
      providerSub,
      tx.code_challenge,
      tx.scopes,
      claimsCiphertext,
      now() + 120,
    )
    .run();
  await rotateBrowserSession(c, accountId);
  const target = new URL(tx.redirect_uri);
  target.searchParams.set("code", authCode);
  if (tx.app_state) {
    target.searchParams.set("state", tx.app_state);
  }

  return c.redirect(target.toString(), 302);
});

oauthRoutes.post("/token", async (c) => {
  const form = await parseOAuthForm(c.req.raw);
  if (form instanceof Response) {
    return form;
  }
  const grantType = form.get("grant_type") ?? "";
  if (!(await enforceRequestRateLimit(c.env.DB, c.req.raw, c.env.RATE_LIMIT_SECRET, "token", 60))) {
    return grantType === "urn:ietf:params:oauth:grant-type:device_code"
      ? oauthError("slow_down")
      : oauthError("temporarily_unavailable", undefined, 429);
  }
  const duplicateError = rejectDuplicateParameters(form, [
    "grant_type",
    "client_id",
    "code",
    "code_verifier",
    "redirect_uri",
    "device_code",
  ]);
  if (duplicateError) {
    return duplicateError;
  }
  const suppliedClientId = form.get("client_id") ?? "";
  if (suppliedClientId.length > clientIdLimit) {
    return oauthError("invalid_client");
  }
  if (
    grantType !== "authorization_code" &&
    grantType !== "urn:ietf:params:oauth:grant-type:device_code"
  ) {
    const client = suppliedClientId ? await getClient(c.env.DB, suppliedClientId) : null;

    return client ? oauthError("unsupported_grant_type") : oauthError("invalid_client");
  }

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    if (
      !code ||
      code.length > authorizationCodeLimit ||
      !validatePkceVerifier(verifier) ||
      !redirectUri ||
      redirectUri.length > redirectUriLimit
    ) {
      return oauthError("invalid_grant");
    }

    let originClientId: string;
    try {
      originClientId = clientIdFromRedirect(redirectUri);
    } catch {
      return oauthError("invalid_client");
    }
    const clientId = suppliedClientId || originClientId;
    const client = await getClient(c.env.DB, clientId);
    if (!client) {
      return oauthError("invalid_client");
    }

    const codeHash = await sha256(code);
    const candidate = await getAuthorizationCode(c.env.DB, codeHash, clientId, redirectUri);
    if (!candidate || !timingSafeEqual(await sha256(verifier), candidate.code_challenge)) {
      return oauthError("invalid_grant");
    }
    try {
      validateClient(
        client,
        clientId === originClientId ? null : redirectUri,
        candidate.provider,
        c.env.ISSUER,
      );
    } catch {
      return oauthError("invalid_client");
    }
    const row = await consumeAuthorizationCode(c.env.DB, codeHash, clientId, redirectUri);
    if (!row) {
      return oauthError("invalid_grant");
    }
    const scopes = parseStoredScopes(row.scopes);
    const claims = row.claims_ciphertext
      ? await openClaims(c.env.CLAIMS_ENCRYPTION_KEYRING, codeHash, row.claims_ciphertext)
      : {};
    await rememberConsent(c.env.DB, row.account_id, clientId, scopes);

    return c.json({
      token_type: "Bearer",
      expires_in: 300,
      scope: serializeScopes(scopes),
      id_token: await issueIdToken(c.env, clientId, row.account_id, row.provider_sub, claims),
    });
  }

  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    const clientId = suppliedClientId;
    const client = clientId ? await getClient(c.env.DB, clientId) : null;
    if (!client) {
      return oauthError("invalid_client");
    }

    const deviceCode = form.get("device_code") ?? "";
    if (!deviceCode || deviceCode.length > deviceCodeLimit) {
      return oauthError("invalid_grant");
    }
    const hash = await sha256(deviceCode);
    const initialState = await getDeviceGrantState(c.env.DB, hash);
    if (!initialState || initialState.client_id !== clientId) {
      return oauthError("invalid_grant");
    }
    try {
      validateClient(client, null, initialState.provider, c.env.ISSUER);
    } catch {
      return oauthError("invalid_client");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const approved = await consumeApprovedDeviceGrant(c.env.DB, hash, clientId);
      if (approved) {
        const scopes = parseStoredScopes(approved.scopes);
        const claims = approved.claims_ciphertext
          ? await openClaims(c.env.CLAIMS_ENCRYPTION_KEYRING, hash, approved.claims_ciphertext)
          : {};
        await rememberConsent(c.env.DB, approved.account_id, clientId, scopes);

        return c.json({
          token_type: "Bearer",
          expires_in: 300,
          scope: serializeScopes(scopes),
          id_token: await issueIdToken(
            c.env,
            clientId,
            approved.account_id,
            approved.provider_sub,
            claims,
          ),
        });
      }

      const state = await getDeviceGrantState(c.env.DB, hash);
      if (!state || state.client_id !== clientId) {
        return oauthError("invalid_grant");
      }
      if (state.expires_at <= now()) {
        return oauthError("expired_token");
      }
      if (state.status === "approved") {
        return oauthError("invalid_grant");
      }
      if (state.status === "denied") {
        return oauthError("access_denied");
      }
      const polling = await pollPendingDeviceGrant(c.env.DB, hash, clientId);
      if (polling) {
        return oauthError(polling);
      }
    }

    return oauthError("invalid_grant");
  }

  return oauthError("unsupported_grant_type");
});

oauthRoutes.onError((_error, c) => {
  console.error("OAuth route failed");

  return c.json({ error: "server_error" }, 500, {
    "cache-control": "no-store",
    pragma: "no-cache",
  });
});
