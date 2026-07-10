import { hmacSha256, sha256 } from "./crypto";

export async function enforceRateLimit(
  db: D1Database,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!bucket || !key || !Number.isSafeInteger(limit) || limit < 1
    || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("invalid rate limit configuration");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(timestamp / windowSeconds) * windowSeconds;
  const keyHash = await sha256(key);
  const cleanupSample = crypto.getRandomValues(new Uint8Array(1))[0];
  if (cleanupSample === 0) {
    await db.prepare(`DELETE FROM rate_limits WHERE rowid IN (
      SELECT rowid FROM rate_limits WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
    )`).bind(timestamp).run();
  }
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, key_hash, window_start, expires_at, count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(bucket, key_hash, window_start) DO UPDATE SET count = count + 1
    WHERE count < ?
    RETURNING count`)
    .bind(bucket, keyHash, windowStart, windowStart + windowSeconds, limit).first<{ count: number }>();
  return row !== null;
}

export async function enforceRequestRateLimit(
  db: D1Database,
  request: Request,
  secret: string,
  bucket: string,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip");
  const key = ip === null ? "unknown" : await hmacSha256(secret, `triad-rate-limit\0${ip}`);
  return enforceRateLimit(
    db,
    bucket,
    key,
    limit,
    windowSeconds,
  );
}
