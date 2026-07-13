import { accountSubject, timingSafeEqual } from "./crypto";
import type { ClientRow, ProviderIdentity, ProviderName, Scope, TransactionRow } from "./types";

export interface AuthorizationCodeRow {
  account_id: string;
  provider: ProviderName;
  provider_sub: string;
  code_challenge: string;
  scopes: string;
  claims_ciphertext: string | null;
}

type AuthorizationCodeCandidateRow = Pick<AuthorizationCodeRow, "code_challenge" | "provider">;

export interface DeviceGrantStateRow {
  client_id: string;
  status: "pending" | "approved" | "denied";
  expires_at: number;
  provider: ProviderName;
}

export interface ApprovedDeviceGrantRow {
  account_id: string;
  provider_sub: string;
  scopes: string;
  claims_ciphertext: string | null;
}

export async function getClient(db: D1Database, clientId: string): Promise<ClientRow | null> {
  return db
    .prepare("SELECT client_id, name, redirect_uris, providers FROM clients WHERE client_id = ?")
    .bind(clientId)
    .first<ClientRow>();
}

function clientUrl(value: string): URL {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";

  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) {
    throw new Error("invalid client origin");
  }

  return url;
}

export function clientIdFromRedirect(redirectUri: string): string {
  const url = clientUrl(redirectUri);
  if (url.hash) {
    throw new Error("redirect_uri must not contain a fragment");
  }

  return url.origin;
}

export function normalizeOriginClientId(clientId: string): string {
  const url = clientUrl(clientId);
  if (clientId !== url.origin) {
    throw new Error("client_id must be an origin URL");
  }

  return url.origin;
}

export async function getOrCreateOriginClient(
  db: D1Database,
  clientId: string,
): Promise<ClientRow> {
  const canonicalId = normalizeOriginClientId(clientId);

  await db
    .prepare(
      `INSERT OR IGNORE INTO clients
      (client_id, name, redirect_uris, providers, created_at)
      VALUES (?, ?, '[]', '["google","github","twitter"]', unixepoch())`,
    )
    .bind(canonicalId, canonicalId)
    .run();

  const client = await getClient(db, canonicalId);
  if (!client) {
    throw new Error("client unavailable");
  }

  return client;
}

export function validateClient(
  client: ClientRow,
  redirectUri: string | null,
  provider: ProviderName,
  issuer: string,
): void {
  const redirectUris: unknown =
    client.client_id === "triad-demo"
      ? [`${issuer}/demo/callback/`]
      : JSON.parse(client.redirect_uris);

  const providers: unknown = JSON.parse(client.providers);

  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.every((value) => typeof value === "string") ||
    !Array.isArray(providers) ||
    !providers.every((value) => typeof value === "string")
  ) {
    throw new Error("invalid client allowlist");
  }
  if (redirectUri !== null && !redirectUris.includes(redirectUri)) {
    throw new Error("invalid redirect_uri");
  }
  if (!providers.includes(provider)) {
    throw new Error("provider not allowed for client");
  }
}

export async function consumeTransaction(
  db: D1Database,
  stateHash: string,
  browserBindingHash: string,
): Promise<TransactionRow | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_transactions WHERE state_hash = ? AND expires_at > unixepoch()")
    .bind(stateHash)
    .first<TransactionRow>();

  if (!row || !timingSafeEqual(row.browser_binding_hash, browserBindingHash)) {
    return null;
  }

  return db
    .prepare(
      `DELETE FROM oauth_transactions
    WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > unixepoch()
    RETURNING *`,
    )
    .bind(stateHash, browserBindingHash)
    .first<TransactionRow>();
}

export async function getAuthorizationCode(
  db: D1Database,
  codeHash: string,
  clientId: string,
  redirectUri: string,
): Promise<AuthorizationCodeCandidateRow | null> {
  return db
    .prepare(
      `SELECT code_challenge, provider FROM authorization_codes
    WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > unixepoch()`,
    )
    .bind(codeHash, clientId, redirectUri)
    .first<AuthorizationCodeCandidateRow>();
}

export async function consumeAuthorizationCode(
  db: D1Database,
  codeHash: string,
  clientId: string,
  redirectUri: string,
): Promise<AuthorizationCodeRow | null> {
  return db
    .prepare(
      `DELETE FROM authorization_codes
    WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > unixepoch()
    RETURNING account_id, provider, provider_sub, code_challenge, scopes, claims_ciphertext`,
    )
    .bind(codeHash, clientId, redirectUri)
    .first<AuthorizationCodeRow>();
}

export async function approveDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  accountId: string,
  providerSub: string,
  claimsCiphertext: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE device_grants
    SET status = 'approved', account_id = ?, provider_sub = ?, claims_ciphertext = ?
    WHERE device_code_hash = ? AND status = 'pending' AND expires_at > unixepoch()`,
    )
    .bind(accountId, providerSub, claimsCiphertext, deviceCodeHash)
    .run();

  return result.meta.changes === 1;
}

export async function denyDeviceGrant(db: D1Database, deviceCodeHash: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE device_grants SET status = 'denied'
    WHERE device_code_hash = ? AND status = 'pending' AND expires_at > unixepoch()`,
    )
    .bind(deviceCodeHash)
    .run();

  return result.meta.changes === 1;
}

export async function consumeApprovedDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  clientId: string,
): Promise<ApprovedDeviceGrantRow | null> {
  return db
    .prepare(
      `DELETE FROM device_grants
    WHERE device_code_hash = ? AND client_id = ? AND status = 'approved'
      AND consumed_at IS NULL AND account_id IS NOT NULL AND provider_sub IS NOT NULL
      AND expires_at > unixepoch()
    RETURNING account_id, provider_sub, scopes, claims_ciphertext`,
    )
    .bind(deviceCodeHash, clientId)
    .first<ApprovedDeviceGrantRow>();
}

export async function getDeviceGrantState(
  db: D1Database,
  deviceCodeHash: string,
): Promise<DeviceGrantStateRow | null> {
  return db
    .prepare(
      `SELECT client_id, status, expires_at, provider FROM device_grants
    WHERE device_code_hash = ?`,
    )
    .bind(deviceCodeHash)
    .first<DeviceGrantStateRow>();
}

export async function pollPendingDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  clientId: string,
): Promise<"authorization_pending" | "slow_down" | null> {
  const slow = () =>
    db
      .prepare(
        `UPDATE device_grants
    SET interval_seconds = interval_seconds + 5, last_polled_at = unixepoch()
    WHERE device_code_hash = ? AND client_id = ? AND status = 'pending' AND consumed_at IS NULL
      AND expires_at > unixepoch() AND last_polled_at IS NOT NULL
      AND unixepoch() - last_polled_at < interval_seconds
    RETURNING device_code_hash`,
      )
      .bind(deviceCodeHash, clientId)
      .first();

  if (await slow()) {
    return "slow_down";
  }

  const accepted = await db
    .prepare(
      `UPDATE device_grants SET last_polled_at = unixepoch()
    WHERE device_code_hash = ? AND client_id = ? AND status = 'pending' AND consumed_at IS NULL
      AND expires_at > unixepoch()
      AND (last_polled_at IS NULL OR unixepoch() - last_polled_at >= interval_seconds)
    RETURNING device_code_hash`,
    )
    .bind(deviceCodeHash, clientId)
    .first();

  if (accepted) {
    return "authorization_pending";
  }

  return (await slow()) ? "slow_down" : null;
}

export async function rememberConsent(
  db: D1Database,
  accountId: string,
  clientId: string,
  scopes: readonly Scope[],
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO consents (account_id, client_id, scopes, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(account_id, client_id) DO UPDATE SET scopes = excluded.scopes, updated_at = excluded.updated_at`,
    )
    .bind(accountId, clientId, JSON.stringify(scopes))
    .run();
}

export async function deleteAccount(db: D1Database, accountId: string): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM csrf_tokens WHERE purpose IN (
        SELECT 'account:' || session_hash FROM browser_sessions WHERE account_id = ?
      )`,
      )
      .bind(accountId),
    db.prepare("DELETE FROM authorization_codes WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM device_grants WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM consents WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM browser_sessions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM identities WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);

  return results.at(-1)?.meta.changes === 1;
}

export async function resolveIdentity(
  db: D1Database,
  identity: ProviderIdentity,
  secret: string,
): Promise<string> {
  const existing = await db
    .prepare("SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?")
    .bind(identity.provider, identity.id)
    .first<{ account_id: string }>();

  if (existing) {
    return existing.account_id;
  }

  const accountId = await accountSubject(secret, identity.provider, identity.id);
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES (?, ?)")
    .bind(accountId, now)
    .run();

  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO identities
      (provider, provider_user_id, account_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(identity.provider, identity.id, accountId, now)
      .run();

    const winner = await db
      .prepare("SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?")
      .bind(identity.provider, identity.id)
      .first<{ account_id: string }>();

    if (!winner) {
      throw new Error("identity resolution failed");
    }

    if (winner.account_id !== accountId) {
      await db
        .prepare(
          `DELETE FROM accounts WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?)`,
        )
        .bind(accountId, accountId)
        .run();
    }

    return winner.account_id;
  } catch (error) {
    await db
      .prepare(
        `DELETE FROM accounts WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?)`,
      )
      .bind(accountId, accountId)
      .run();

    throw error;
  }
}
