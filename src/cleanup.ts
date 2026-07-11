export const stateCleanupBatchSize = 100;
export const stateCleanupSampleDenominator = 16;

export async function cleanupExpiredState(db: D1Database): Promise<void> {
  const sample = crypto.getRandomValues(new Uint8Array(1))[0];
  if (sample >= 256 / stateCleanupSampleDenominator) {
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare(
        `DELETE FROM consent_requests WHERE rowid IN (
      SELECT rowid FROM consent_requests WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM oauth_transactions WHERE rowid IN (
      SELECT rowid FROM oauth_transactions WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM authorization_codes WHERE rowid IN (
      SELECT rowid FROM authorization_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL
      ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM device_grants WHERE rowid IN (
      SELECT rowid FROM device_grants WHERE expires_at <= ? OR consumed_at IS NOT NULL
      ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM browser_sessions WHERE rowid IN (
      SELECT rowid FROM browser_sessions WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM csrf_tokens WHERE rowid IN (
      SELECT rowid FROM csrf_tokens WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
    )`,
      )
      .bind(timestamp),
  ]);
}
