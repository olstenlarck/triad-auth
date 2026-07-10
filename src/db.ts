import { randomToken } from "./crypto";
import type { ClientRow, ProviderIdentity, ProviderName, TransactionRow } from "./types";

export async function getClient(db: D1Database, clientId: string): Promise<ClientRow | null> {
  return db.prepare("SELECT client_id, name, redirect_uris, providers FROM clients WHERE client_id = ?")
    .bind(clientId).first<ClientRow>();
}

export function validateClient(client: ClientRow, redirectUri: string | null, provider?: ProviderName): void {
  if (redirectUri && !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    throw new Error("invalid redirect_uri");
  }
  if (provider && !(JSON.parse(client.providers) as string[]).includes(provider)) {
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
