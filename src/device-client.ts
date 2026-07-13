import { normalizeOriginClientId } from "./db";

const proofPath = "/.well-known/triad-client.json";
const proofTimeoutMs = 5_000;
const proofByteLimit = 4_096;
const verificationLifetimeSeconds = 3_600;
const internalHostnameSuffixes = [".localhost", ".local", ".internal"];

interface VerificationRow {
  name: string;
}

function canonicalDeviceClientId(clientId: string): string {
  const canonicalId = normalizeOriginClientId(clientId);
  const url = new URL(canonicalId);
  if (url.protocol === "http:" && url.hostname === "localhost") {
    return canonicalId;
  }

  const ipLiteral =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
    (url.hostname.startsWith("[") && url.hostname.endsWith("]"));
  const internalHostname =
    !url.hostname.includes(".") ||
    internalHostnameSuffixes.some((suffix) => url.hostname.endsWith(suffix));
  if (ipLiteral || internalHostname) {
    throw new Error("device client must use a public HTTPS origin");
  }

  return canonicalId;
}

function validateContentHeaders(response: Response): void {
  if (!response.ok) {
    throw new Error("device client proof request failed");
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("device client proof must be JSON");
  }

  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > proofByteLimit)
  ) {
    throw new Error("device client proof is too large");
  }
}

function validateProof(
  value: unknown,
  canonicalId: string,
  issuer: string,
): { name: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid device client proof");
  }

  const proof = value as Record<string, unknown>;
  if (
    proof.issuer !== issuer ||
    proof.client_id !== canonicalId ||
    proof.device_authorization !== true
  ) {
    throw new Error("invalid device client proof");
  }

  const name = proof.name;
  if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 80)) {
    throw new Error("invalid device client name");
  }

  return { name: name ?? canonicalId };
}

export async function verifyDeviceClient(
  db: D1Database,
  clientId: string,
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<{ name: string }> {
  const canonicalId = canonicalDeviceClientId(clientId);

  const cached = await db
    .prepare(
      `SELECT name FROM device_client_verifications
      WHERE client_id = ? AND expires_at > unixepoch()`,
    )
    .bind(canonicalId)
    .first<VerificationRow>();
  if (cached) {
    return { name: cached.name };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), proofTimeoutMs);
  let response: Response;
  try {
    response = await fetcher(`${canonicalId}${proofPath}`, {
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("device client proof unavailable");
  } finally {
    clearTimeout(timeout);
  }

  validateContentHeaders(response);
  const body = await response.arrayBuffer();
  if (body.byteLength > proofByteLimit) {
    throw new Error("device client proof is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("invalid device client proof JSON");
  }
  const verification = validateProof(value, canonicalId, issuer);

  await db
    .prepare(
      `INSERT INTO device_client_verifications (client_id, name, verified_at, expires_at)
      VALUES (?, ?, unixepoch(), unixepoch() + ?)
      ON CONFLICT(client_id) DO UPDATE SET
        name = excluded.name,
        verified_at = excluded.verified_at,
        expires_at = excluded.expires_at`,
    )
    .bind(canonicalId, verification.name, verificationLifetimeSeconds)
    .run();

  return verification;
}
