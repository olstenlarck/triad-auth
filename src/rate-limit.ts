import { sha256 } from "./crypto";

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
  await db.prepare("DELETE FROM rate_limits WHERE bucket = ? AND window_start < ?")
    .bind(bucket, windowStart).run();
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, key_hash, window_start, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, key_hash, window_start) DO UPDATE SET count = count + 1
    WHERE count < ?
    RETURNING count`)
    .bind(bucket, keyHash, windowStart, limit).first<{ count: number }>();
  return row !== null;
}

export function enforceRequestRateLimit(
  db: D1Database,
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  return enforceRateLimit(
    db,
    bucket,
    request.headers.get("cf-connecting-ip") ?? "unknown",
    limit,
    windowSeconds,
  );
}
