import { normalizeOriginClientId } from "./db";

const proofPath = "/.well-known/triad-client.json";
const proofTimeoutMs = 5_000;
const proofByteLimit = 4_096;
const verificationLifetimeSeconds = 3_600;
const internalHostnameNamespaces = ["localhost", "local", "internal", "home.arpa"];

interface VerificationRow {
  name: string;
}

function canonicalDeviceClientId(clientId: string): string {
  const canonicalId = normalizeOriginClientId(clientId);
  const url = new URL(canonicalId);
  if (url.protocol === "http:" && url.hostname === "localhost") {
    return canonicalId;
  }

  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const ipLiteral =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]"));
  const internalHostname =
    !hostname.includes(".") ||
    internalHostnameNamespaces.some(
      (namespace) => hostname === namespace || hostname.endsWith(`.${namespace}`),
    );
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

async function readProofBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const body = new Uint8Array(proofByteLimit);
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return body.subarray(0, length);
    }
    if (length + value.byteLength > proofByteLimit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("device client proof is too large");
    }

    body.set(value, length);
    length += value.byteLength;
  }
}

function validateProof(value: unknown, canonicalId: string, issuer: string): { name: string } {
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
  if (name !== undefined) {
    if (typeof name !== "string") {
      throw new Error("invalid device client name");
    }

    const nameLength = Array.from(name).length;
    if (nameLength < 1 || nameLength > 80) {
      throw new Error("invalid device client name");
    }
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
  let body: Uint8Array;
  try {
    let response: Response;
    try {
      response = await fetcher(`${canonicalId}${proofPath}`, {
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new Error("device client proof unavailable");
    }

    validateContentHeaders(response);
    body = await readProofBody(response);
  } finally {
    clearTimeout(timeout);
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
