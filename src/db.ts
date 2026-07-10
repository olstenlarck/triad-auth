import { randomToken } from "./crypto";
import type { ClientRow, ProviderIdentity, ProviderName, TransactionRow } from "./types";

export interface AuthorizationCodeRow {
  account_id: string;
  provider_sub: string;
  code_challenge: string;
}

export interface DeviceGrantStateRow {
  status: "pending" | "approved" | "denied";
  expires_at: number;
  consumed_at: number | null;
}

export interface ApprovedDeviceGrantRow {
  account_id: string;
  provider_sub: string;
}

export async function getClient(db: D1Database, clientId: string): Promise<ClientRow | null> {
  return db.prepare("SELECT client_id, name, redirect_uris, providers FROM clients WHERE client_id = ?")
    .bind(clientId).first<ClientRow>();
}

export function validateClient(client: ClientRow, redirectUri: string | null, provider: ProviderName): void {
  const redirectUris: unknown = JSON.parse(client.redirect_uris);
  const providers: unknown = JSON.parse(client.providers);
  if (!Array.isArray(redirectUris) || !redirectUris.every((value) => typeof value === "string")
    || !Array.isArray(providers) || !providers.every((value) => typeof value === "string")) {
    throw new Error("invalid client allowlist");
  }
  if (redirectUri !== null && !redirectUris.includes(redirectUri)) {
    throw new Error("invalid redirect_uri");
  }
  if (provider !== "github" || !providers.includes(provider)) {
    throw new Error("provider not allowed for client");
  }
}

export async function consumeTransaction(db: D1Database, stateHash: string): Promise<TransactionRow | null> {
  const row = await db.prepare("SELECT * FROM oauth_transactions WHERE state_hash = ? AND expires_at > unixepoch()")
    .bind(stateHash).first<TransactionRow>();
  if (!row) return null;
  const deletion = await db.prepare("DELETE FROM oauth_transactions WHERE state_hash = ?")
    .bind(stateHash).run();
  return deletion.meta.changes === 1 ? row : null;
}

export async function getAuthorizationCode(
  db: D1Database,
  codeHash: string,
  clientId: string,
  redirectUri: string,
): Promise<AuthorizationCodeRow | null> {
  return db.prepare(`SELECT account_id, provider_sub, code_challenge FROM authorization_codes
    WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > unixepoch()`)
    .bind(codeHash, clientId, redirectUri).first<AuthorizationCodeRow>();
}

export async function consumeAuthorizationCode(
  db: D1Database,
  codeHash: string,
  clientId: string,
  redirectUri: string,
): Promise<AuthorizationCodeRow | null> {
  return db.prepare(`UPDATE authorization_codes SET consumed_at = unixepoch()
    WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > unixepoch()
    RETURNING account_id, provider_sub, code_challenge`)
    .bind(codeHash, clientId, redirectUri).first<AuthorizationCodeRow>();
}

export async function approveDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  accountId: string,
  providerSub: string,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE device_grants SET status = 'approved', account_id = ?, provider_sub = ?
    WHERE device_code_hash = ? AND status = 'pending' AND expires_at > unixepoch()`)
    .bind(accountId, providerSub, deviceCodeHash).run();
  return result.meta.changes === 1;
}

export async function consumeApprovedDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  clientId: string,
): Promise<ApprovedDeviceGrantRow | null> {
  return db.prepare(`UPDATE device_grants SET consumed_at = unixepoch()
    WHERE device_code_hash = ? AND client_id = ? AND status = 'approved'
      AND consumed_at IS NULL AND account_id IS NOT NULL AND provider_sub IS NOT NULL
      AND expires_at > unixepoch()
    RETURNING account_id, provider_sub`)
    .bind(deviceCodeHash, clientId).first<ApprovedDeviceGrantRow>();
}

export async function getDeviceGrantState(
  db: D1Database,
  deviceCodeHash: string,
  clientId: string,
): Promise<DeviceGrantStateRow | null> {
  return db.prepare(`SELECT status, expires_at, consumed_at FROM device_grants
    WHERE device_code_hash = ? AND client_id = ?`)
    .bind(deviceCodeHash, clientId).first<DeviceGrantStateRow>();
}

export async function pollPendingDeviceGrant(
  db: D1Database,
  deviceCodeHash: string,
  clientId: string,
): Promise<"authorization_pending" | "slow_down" | null> {
  const slow = () => db.prepare(`UPDATE device_grants
    SET interval_seconds = interval_seconds + 5, last_polled_at = unixepoch()
    WHERE device_code_hash = ? AND client_id = ? AND status = 'pending' AND consumed_at IS NULL
      AND expires_at > unixepoch() AND last_polled_at IS NOT NULL
      AND unixepoch() - last_polled_at < interval_seconds
    RETURNING device_code_hash`).bind(deviceCodeHash, clientId).first();
  if (await slow()) return "slow_down";

  const accepted = await db.prepare(`UPDATE device_grants SET last_polled_at = unixepoch()
    WHERE device_code_hash = ? AND client_id = ? AND status = 'pending' AND consumed_at IS NULL
      AND expires_at > unixepoch()
      AND (last_polled_at IS NULL OR unixepoch() - last_polled_at >= interval_seconds)
    RETURNING device_code_hash`).bind(deviceCodeHash, clientId).first();
  if (accepted) return "authorization_pending";

  return await slow() ? "slow_down" : null;
}

export async function rememberConsent(db: D1Database, accountId: string, clientId: string): Promise<void> {
  await db.prepare(`INSERT INTO consents (account_id, client_id, scopes, updated_at)
    VALUES (?, ?, '["openid"]', unixepoch())
    ON CONFLICT(account_id, client_id) DO UPDATE SET scopes = excluded.scopes, updated_at = excluded.updated_at`)
    .bind(accountId, clientId).run();
}

export async function resolveIdentity(db: D1Database, identity: ProviderIdentity): Promise<string> {
  const existing = await db.prepare("SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?")
    .bind(identity.provider, identity.id).first<{ account_id: string }>();
  if (existing) return existing.account_id;

  const accountId = `acct_${randomToken(18)}`;
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").bind(accountId, now),
    db.prepare("INSERT INTO identities (provider, provider_user_id, account_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(identity.provider, identity.id, accountId, now),
  ]);
  return accountId;
}
