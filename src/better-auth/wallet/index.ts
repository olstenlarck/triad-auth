import {
  generateAuthenticationOptions,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { BetterAuthPlugin } from "better-auth";

import type { TriadEnv } from "../env";
import { isIdentityPasskey, storedPasskeyPublicKeyBytes } from "../identity/passkey-public-key";
import { pairwiseSubject } from "../identity/subjects";
import {
  parseWalletAuthorizationInput,
  WALLET_REQUEST_BODY_LIMIT,
  WALLET_REQUEST_TTL_MS,
  type WalletAuthorizationInput,
  type WalletAuthorizationRequestBody,
  walletErrorRedirectUri,
  walletNamespaceSubject,
  walletPrfSaltBase64Url,
  walletRedirectUri,
  walletSigningMessage,
} from "./protocol";
import type { WalletProfileId } from "./profiles";
import { verifyPrfWalletSignature } from "./signatures";

const walletBrokerSchema = {
  walletRequest: {
    fields: {
      userId: {
        type: "string",
        required: true,
        references: { model: "user", field: "id", onDelete: "cascade" },
        index: true,
      },
      clientId: {
        type: "string",
        required: true,
        references: { model: "oauthClient", field: "clientId", onDelete: "cascade" },
        index: true,
      },
      credentialId: { type: "string", required: true },
      redirectUri: { type: "string", required: true },
      state: { type: "string", required: true },
      message: { type: "string", required: true },
      namespace: { type: "string", required: true },
      namespaceSubject: { type: "string", required: true },
      walletProfile: { type: "string", required: true },
      accountIndex: { type: "number", required: true },
      chainId: { type: "number", required: false },
      derivationPath: { type: "string", required: true },
      challenge: { type: "string", required: true },
      signingMessage: { type: "string", required: true },
      expiresAt: { type: "date", required: true, index: true },
      consumedAt: { type: "date", required: false },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

export const walletBrokerPlugin = {
  id: "wallet-broker",
  schema: walletBrokerSchema,
} satisfies BetterAuthPlugin;

interface WalletAuthService {
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
  };
}

interface OAuthClientRecord {
  clientId: string;
  name: string | null;
  redirectUris: string;
}

interface IdentityRecord {
  id: string;
  provider: string;
  providerSub: string;
}

interface PasskeyRecord {
  id: string;
  name: string | null;
  credentialID: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  backedUp: number;
  createdAt: number | string | null;
}

interface WalletRequestRecord {
  id: string;
  userId: string;
  clientId: string;
  credentialId: string;
  redirectUri: string;
  state: string;
  message: string;
  namespace: WalletAuthorizationInput["namespace"];
  namespaceSubject: string;
  walletProfile: WalletProfileId;
  accountIndex: number;
  chainId: number | null;
  derivationPath: string;
  challenge: string;
  signingMessage: string;
  expiresAt: number;
  consumedAt: number | null;
}

interface WalletContext {
  user: IdentityRecord;
  client: OAuthClientRecord;
  request: WalletAuthorizationInput;
  namespaceSubject: string;
  passkeys: PasskeyRecord[];
}

class WalletBrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

function invalid(message: string): never {
  throw new WalletBrokerError(400, "invalid_request", message);
}

function parseRedirectUris(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((uri) => typeof uri === "string")) {
      return parsed;
    }
  } catch {
    // Malformed client metadata does not authorize a redirect.
  }

  return [];
}

function webAuthnTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) {
    return undefined;
  }
  const supported = new Set<AuthenticatorTransportFuture>([
    "ble",
    "cable",
    "hybrid",
    "internal",
    "nfc",
    "smart-card",
    "usb",
  ]);
  const transports = value
    .split(",")
    .filter((transport): transport is AuthenticatorTransportFuture =>
      supported.has(transport as AuthenticatorTransportFuture),
    );

  return transports.length > 0 ? transports : undefined;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) {
    invalid("A JSON request body is required");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > WALLET_REQUEST_BODY_LIMIT) {
    throw new WalletBrokerError(413, "request_too_large", "Wallet requests are limited to 16 KiB");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > WALLET_REQUEST_BODY_LIMIT) {
      await reader.cancel();
      throw new WalletBrokerError(
        413,
        "request_too_large",
        "Wallet requests are limited to 16 KiB",
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("Request body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function requireSameOrigin(request: Request, env: TriadEnv): void {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(env.AUTH_ORIGIN).origin;
  } catch {
    throw new WalletBrokerError(500, "server_error", "Wallet broker origin is invalid");
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    throw new WalletBrokerError(403, "forbidden", "Wallet requests require the Triad origin");
  }
}

async function walletPasskeys(
  env: TriadEnv,
  user: IdentityRecord,
  passkeys: PasskeyRecord[],
): Promise<PasskeyRecord[]> {
  if (user.provider === "ethereum") {
    invalid("EVM Identity Sources do not provide PRF wallets");
  }
  if (user.provider === "google" || user.provider === "github" || user.provider === "twitter") {
    return passkeys;
  }
  if (user.provider !== "passkey") {
    invalid("Identity Source does not support PRF wallets");
  }

  const identityPasskeys = await Promise.all(
    passkeys.map(async (passkey) => ({
      passkey,
      identity: await isIdentityPasskey(env.IDENTIFIER_SECRET, user.providerSub, passkey.publicKey),
    })),
  );

  return identityPasskeys.filter(({ identity }) => identity).map(({ passkey }) => passkey);
}

async function walletContext(
  body: WalletAuthorizationRequestBody,
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
): Promise<WalletContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    throw new WalletBrokerError(
      401,
      "authentication_required",
      "Sign in to authorize this wallet request",
    );
  }

  let authorization: WalletAuthorizationInput;
  try {
    authorization = parseWalletAuthorizationInput(body);
  } catch (reason) {
    invalid(reason instanceof Error ? reason.message : "Wallet authorization request is invalid");
  }

  const [user, client, passkeyResult] = await Promise.all([
    env.DB.prepare('select "id", "provider", "providerSub" from "user" where "id" = ? limit 1')
      .bind(session.user.id)
      .first<IdentityRecord>(),
    env.DB.prepare(
      'select "clientId", "name", "redirectUris" from "oauthClient" where "clientId" = ? and coalesce("disabled", 0) = 0 limit 1',
    )
      .bind(authorization.clientId)
      .first<OAuthClientRecord>(),
    env.DB.prepare(
      'select "id", "name", "credentialID", "publicKey", "counter", "transports", "backedUp", "createdAt" from "passkey" where "userId" = ? order by "createdAt" asc',
    )
      .bind(session.user.id)
      .all<PasskeyRecord>(),
  ]);
  if (!user) {
    throw new WalletBrokerError(401, "authentication_required", "Triad account is unavailable");
  }
  if (!client || !parseRedirectUris(client.redirectUris).includes(authorization.redirectUri)) {
    invalid("Client ID and redirect URI do not match a registered application");
  }

  const clientSubject = await pairwiseSubject(env.IDENTIFIER_SECRET, user.id, client.clientId);
  const namespaceSubject = walletNamespaceSubject(authorization.namespace, {
    account: user.id,
    client: clientSubject,
    source: user.providerSub,
  });

  return {
    user,
    client,
    request: authorization,
    namespaceSubject,
    passkeys: await walletPasskeys(env, user, passkeyResult.results),
  };
}

function publicContext(context: WalletContext) {
  return {
    client: {
      id: context.client.clientId,
      name: context.client.name?.trim() || context.client.clientId,
    },
    request: {
      message: context.request.message,
      namespace: context.request.namespace,
      namespace_subject: context.namespaceSubject,
      wallet_profile: context.request.walletProfile,
      account_index: context.request.accountIndex,
      derivation_path: context.request.path,
      ...(context.request.chainId ? { chain_id: context.request.chainId } : {}),
    },
    identity_source: context.user.provider,
    cancel_uri: walletErrorRedirectUri(
      context.request.redirectUri,
      context.request.state,
      "access_denied",
    ),
    passkeys: context.passkeys.map((passkey) => ({
      id: passkey.id,
      name: passkey.name?.trim() || "Unnamed passkey",
      backed_up: passkey.backedUp === 1,
      created_at: passkey.createdAt,
    })),
  };
}

async function inspectWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const body = await readBoundedJson(request);
  const context = await walletContext(body, request, env, auth);

  return json(publicContext(context));
}

async function inspectAccountPasskeys(request: Request, env: TriadEnv, auth: WalletAuthService) {
  await readBoundedJson(request);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    throw new WalletBrokerError(401, "authentication_required", "Sign in to manage passkeys");
  }

  const [user, passkeyResult] = await Promise.all([
    env.DB.prepare('select "id", "provider", "providerSub" from "user" where "id" = ? limit 1')
      .bind(session.user.id)
      .first<IdentityRecord>(),
    env.DB.prepare(
      'select "id", "name", "credentialID", "publicKey", "counter", "transports", "backedUp", "createdAt" from "passkey" where "userId" = ? order by "createdAt" asc',
    )
      .bind(session.user.id)
      .all<PasskeyRecord>(),
  ]);
  if (!user) {
    throw new WalletBrokerError(401, "authentication_required", "Triad account is unavailable");
  }

  const passkeys = await Promise.all(
    passkeyResult.results.map(async (passkey) => {
      const identity =
        user.provider === "passkey" &&
        (await isIdentityPasskey(env.IDENTIFIER_SECRET, user.providerSub, passkey.publicKey));
      const wallet =
        identity ||
        user.provider === "google" ||
        user.provider === "github" ||
        user.provider === "twitter";

      return {
        id: passkey.id,
        name: passkey.name,
        backedUp: passkey.backedUp === 1,
        createdAt: passkey.createdAt,
        role: identity ? "identity" : wallet ? "wallet" : "login",
        removable: !identity,
      };
    }),
  );

  return json(passkeys);
}

async function createWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const body = await readBoundedJson(request);
  const context = await walletContext(body, request, env, auth);
  const credentialId = body.credential_id;
  if (typeof credentialId !== "string") {
    invalid("Select a Wallet Passkey");
  }
  const passkey = context.passkeys.find((candidate) => candidate.id === credentialId);
  if (!passkey) {
    invalid("Selected passkey cannot supply a wallet seed for this Identity Source");
  }

  const now = Date.now();
  await env.DB.prepare('delete from "walletRequest" where "expiresAt" <= ?').bind(now).run();
  const pending = await env.DB.prepare(
    'select count(*) as "count" from "walletRequest" where "userId" = ? and "consumedAt" is null and "expiresAt" > ?',
  )
    .bind(context.user.id, now)
    .first<{ count: number }>();
  if ((pending?.count ?? 0) >= 10) {
    throw new WalletBrokerError(
      429,
      "too_many_requests",
      "Complete an existing wallet request before starting another",
    );
  }

  const origin = new URL(env.AUTH_ORIGIN);
  const options = await generateAuthenticationOptions({
    rpID: origin.hostname,
    userVerification: "required",
    allowCredentials: [
      { id: passkey.credentialID, transports: webAuthnTransports(passkey.transports) },
    ],
  });
  const requestId = crypto.randomUUID();
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + WALLET_REQUEST_TTL_MS);
  const signingMessage = walletSigningMessage({
    origin: origin.origin,
    clientId: context.client.clientId,
    requestId,
    namespace: context.request.namespace,
    namespaceSubject: context.namespaceSubject,
    walletProfile: context.request.walletProfile,
    accountIndex: context.request.accountIndex,
    path: context.request.path,
    ...(context.request.chainId ? { chainId: context.request.chainId } : {}),
    message: context.request.message,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  await env.DB.prepare(
    'insert into "walletRequest" ("id", "userId", "clientId", "credentialId", "redirectUri", "state", "message", "namespace", "namespaceSubject", "walletProfile", "accountIndex", "chainId", "derivationPath", "challenge", "signingMessage", "expiresAt", "consumedAt", "createdAt") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)',
  )
    .bind(
      requestId,
      context.user.id,
      context.client.clientId,
      passkey.id,
      context.request.redirectUri,
      context.request.state,
      context.request.message,
      context.request.namespace,
      context.namespaceSubject,
      context.request.walletProfile,
      context.request.accountIndex,
      context.request.chainId ?? null,
      context.request.path,
      options.challenge,
      signingMessage,
      expiresAt.getTime(),
      issuedAt.getTime(),
    )
    .run();

  return json({
    request_id: requestId,
    options,
    prf_salt: await walletPrfSaltBase64Url(context.request.namespace, context.namespaceSubject),
    signing_message: signingMessage,
    expires_at: expiresAt.toISOString(),
  });
}

function authenticationResponse(value: unknown): AuthenticationResponseJSON {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("Passkey assertion is required");
  }

  return value as AuthenticationResponseJSON;
}

function signedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(`${name} is invalid`);
  }

  return value;
}

async function completeWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    throw new WalletBrokerError(
      401,
      "authentication_required",
      "Sign in to authorize this wallet request",
    );
  }

  const body = await readBoundedJson(request);
  const requestId = body.request_id;
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)) {
    invalid("Wallet request ID is invalid");
  }
  const address = signedString(body.address, "Derived wallet address", 128);
  const signature = signedString(body.signature, "Wallet signature", 2_048);
  const response = authenticationResponse(body.response);

  const walletRequest = await env.DB.prepare(
    'select "id", "userId", "clientId", "credentialId", "redirectUri", "state", "message", "namespace", "namespaceSubject", "walletProfile", "accountIndex", "chainId", "derivationPath", "challenge", "signingMessage", "expiresAt", "consumedAt" from "walletRequest" where "id" = ? and "userId" = ? limit 1',
  )
    .bind(requestId, session.user.id)
    .first<WalletRequestRecord>();
  if (
    !walletRequest ||
    walletRequest.consumedAt !== null ||
    walletRequest.expiresAt <= Date.now()
  ) {
    invalid("Wallet request is missing, expired, or already used");
  }

  const passkey = await env.DB.prepare(
    'select "id", "name", "credentialID", "publicKey", "counter", "transports", "backedUp", "createdAt" from "passkey" where "id" = ? and "userId" = ? limit 1',
  )
    .bind(walletRequest.credentialId, session.user.id)
    .first<PasskeyRecord>();
  if (!passkey || response.id !== passkey.credentialID) {
    invalid("Wallet request passkey does not match the assertion");
  }

  const consumedAt = Date.now();
  const consumed = await env.DB.prepare(
    'update "walletRequest" set "consumedAt" = ? where "id" = ? and "userId" = ? and "consumedAt" is null and "expiresAt" > ?',
  )
    .bind(consumedAt, requestId, session.user.id, consumedAt)
    .run();
  if (consumed.meta.changes !== 1) {
    invalid("Wallet request is missing, expired, or already used");
  }

  let verification;
  try {
    const origin = new URL(env.AUTH_ORIGIN);
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: walletRequest.challenge,
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      credential: {
        id: passkey.credentialID,
        publicKey: storedPasskeyPublicKeyBytes(passkey.publicKey),
        counter: passkey.counter,
        transports: webAuthnTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    invalid("Triad rejected the passkey assertion");
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    invalid("Wallet authorization requires passkey user verification");
  }

  if (
    !(await verifyPrfWalletSignature(
      walletRequest.walletProfile,
      address,
      signature,
      walletRequest.signingMessage,
    ))
  ) {
    invalid("Derived wallet signature does not match this request");
  }

  await env.DB.prepare('update "passkey" set "counter" = ? where "id" = ? and "userId" = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.id, session.user.id)
    .run();

  return json({
    redirect_uri: walletRedirectUri(walletRequest.redirectUri, {
      state: walletRequest.state,
      requestId: walletRequest.id,
      address,
      signature,
      namespace: walletRequest.namespace,
      namespaceSubject: walletRequest.namespaceSubject,
      walletProfile: walletRequest.walletProfile,
      accountIndex: walletRequest.accountIndex,
      path: walletRequest.derivationPath,
      ...(walletRequest.chainId ? { chainId: walletRequest.chainId } : {}),
      message: walletRequest.signingMessage,
    }),
  });
}

export async function handleWalletBrokerRequest(
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  try {
    requireSameOrigin(request, env);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/wallet/passkeys") {
      return await inspectAccountPasskeys(request, env, auth);
    }
    if (pathname === "/api/wallet/inspect") {
      return await inspectWalletRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/options") {
      return await createWalletRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/complete") {
      return await completeWalletRequest(request, env, auth);
    }

    return json({ error: "not_found" }, 404);
  } catch (reason) {
    if (reason instanceof WalletBrokerError) {
      return json({ error: reason.code, message: reason.message }, reason.status);
    }

    return json(
      { error: "server_error", message: "Triad could not process the wallet request" },
      500,
    );
  }
}

export {
  parseWalletAuthorizationInput,
  type WalletAuthorizationInput,
  type WalletNamespace,
  walletPrfSalt,
  walletRedirectUri,
  walletSigningMessage,
} from "./protocol";
export {
  WALLET_PROFILE_IDS,
  type WalletProfileId,
  walletAccountIndex,
  walletDerivationPath,
  walletProfile,
} from "./profiles";
export { signPrfWallet, verifyPrfWalletSignature } from "./signatures";
