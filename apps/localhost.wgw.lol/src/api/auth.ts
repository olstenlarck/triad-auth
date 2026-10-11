import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { SESSION_COOKIE, SESSION_TTL, newHandleFor, parseCookies, sessionCookie } from "../auth";
import { appEnv, db } from "../context";
import { base64UrlEncode, isRecord, randomBytes, randomId } from "../utils";
import { HttpError, principalOf } from "./http";

export const auth = new Hono();

type Provider = "google" | "passkey" | "agentid";

// Triad brokers Google and passkey identities. Google users may attach a passkey inside Triad as
// their second factor. AgentID signs agents in with their AgentMail inbox.
const TRIAD_SCOPES: Record<Exclude<Provider, "agentid">, string> = {
  google: "openid email name avatar",
  passkey: "openid handle",
};
const TRIAD_RESOURCE_PATH = "/demo";
const STATE_TTL = 600;

interface PendingLogin {
  provider: Provider;
  verifier: string;
  nonce: string;
  returnTo: string;
  issuer: string;
  tokenEndpoint: string;
  jwksUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }

  return set;
}

export function clientId(): string {
  return `${appEnv().APP_ORIGIN}/oauth-client.json`;
}

export function clientMetadataDocument() {
  const origin = appEnv().APP_ORIGIN;

  return {
    client_id: clientId(),
    client_name: "localhost",
    client_uri: origin,
    logo_uri: `${origin}/logo.svg`,
    redirect_uris: [`${origin}/auth/callback/triad`],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid email handle name avatar",
  };
}

async function discover(provider: Provider): Promise<Discovery> {
  const env = appEnv();
  const url =
    provider === "agentid"
      ? `${env.AGENTID_ISSUER}/.well-known/openid-configuration`
      : `${env.TRIAD_ISSUER}/api/auth/.well-known/openid-configuration`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 300 },
  });
  if (!response.ok) {
    throw new HttpError(502, "identity provider discovery failed", "upstream");
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.issuer !== "string" ||
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.jwks_uri !== "string"
  ) {
    throw new HttpError(502, "identity provider discovery is malformed", "upstream");
  }

  return {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
  };
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  return base64UrlEncode(new Uint8Array(digest));
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !/^\/(?![/\\])/.test(value)) {
    return "/";
  }
  const origin = appEnv().APP_ORIGIN;
  const url = new URL(value, origin);
  if (url.origin !== origin) {
    return "/";
  }

  return `${url.pathname}${url.search}`;
}

const LOGIN_COOKIE = "lh_login";

function loginCookie(state: string, secure: boolean): string {
  const attributes = [
    `${LOGIN_COOKIE}=${state}`,
    "Path=/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

auth.get("/login", async (c) => {
  const provider = c.req.query("provider");
  if (provider !== "google" && provider !== "passkey" && provider !== "agentid") {
    throw new HttpError(400, "provider must be google, passkey, or agentid", "invalid_request");
  }
  const env = appEnv();
  const discovery = await discover(provider);
  const state = randomId(32);
  const verifier = base64UrlEncode(randomBytes(48));
  const nonce = randomId(24);
  const pending: PendingLogin = {
    provider,
    verifier,
    nonce,
    returnTo: safeReturnTo(c.req.query("return_to")),
    issuer: discovery.issuer,
    tokenEndpoint: discovery.token_endpoint,
    jwksUri: discovery.jwks_uri,
  };
  await env.KV.put(`login:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (provider === "agentid") {
    url.searchParams.set("client_id", env.APP_ORIGIN);
    url.searchParams.set("redirect_uri", `${env.APP_ORIGIN}/auth/callback/agentid`);
    url.searchParams.set("scope", "openid email");
  } else {
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("redirect_uri", `${env.APP_ORIGIN}/auth/callback/triad`);
    url.searchParams.set("scope", TRIAD_SCOPES[provider]);
    url.searchParams.set("resource", `${env.TRIAD_ISSUER}${TRIAD_RESOURCE_PATH}`);
  }
  url.searchParams.set("nonce", nonce);

  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": loginCookie(state, new URL(c.req.url).protocol === "https:"),
    },
  });
});

interface VerifiedLogin {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  ownerEmail: string | null;
  name: string;
  handleHint: string;
  avatar: string | null;
  kind: "human" | "agent";
}

async function exchange(
  c: Parameters<typeof principalOf>[0],
  provider: "triad" | "agentid",
): Promise<VerifiedLogin> {
  const env = appEnv();
  const error = c.req.query("error");
  if (error) {
    throw new HttpError(
      400,
      `${error}: ${c.req.query("error_description") ?? "sign-in was refused"}`,
      error,
    );
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    throw new HttpError(400, "missing code or state", "invalid_request");
  }
  // The state must match the cookie set when this browser started the login, so a callback URL
  // captured by someone else cannot sign this browser into their account.
  if (parseCookies(c.req.header("cookie") ?? null).get(LOGIN_COOKIE) !== state) {
    throw new HttpError(
      400,
      "the sign-in request does not belong to this browser, start again",
      "invalid_request",
    );
  }
  const raw = await env.KV.get(`login:${state}`);
  if (!raw) {
    throw new HttpError(400, "the sign-in request expired, start again", "invalid_request");
  }
  await env.KV.delete(`login:${state}`);
  // SAFETY: login:<state> entries are written only by /auth/login with JSON.stringify(PendingLogin).
  const pending = JSON.parse(raw) as PendingLogin;
  const expectedProvider =
    provider === "agentid"
      ? "agentid"
      : pending.provider === "agentid"
        ? "mismatch"
        : pending.provider;
  if (
    expectedProvider === "mismatch" ||
    (provider === "agentid") !== (pending.provider === "agentid")
  ) {
    throw new HttpError(400, "callback does not match the sign-in request", "invalid_request");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: pending.verifier,
    redirect_uri: `${env.APP_ORIGIN}/auth/callback/${provider}`,
    client_id: provider === "agentid" ? env.APP_ORIGIN : clientId(),
  });
  if (provider === "triad") {
    form.set("resource", `${env.TRIAD_ISSUER}${TRIAD_RESOURCE_PATH}`);
  }
  const response = await fetch(pending.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || typeof body.id_token !== "string") {
    const detail = isRecord(body)
      ? String(body.error_description ?? body.error ?? response.status)
      : String(response.status);
    throw new HttpError(502, `token exchange failed: ${detail}`, "upstream");
  }

  const audience = provider === "agentid" ? env.APP_ORIGIN : clientId();
  const { payload } = await jwtVerify(body.id_token, jwks(pending.jwksUri), {
    issuer: pending.issuer,
    audience,
    algorithms: ["ES256"],
  });
  if (typeof payload.sub !== "string") {
    throw new HttpError(502, "id_token has no subject", "upstream");
  }
  if (payload.nonce !== pending.nonce) {
    throw new HttpError(400, "nonce mismatch", "invalid_request");
  }
  const email = typeof payload.email === "string" ? payload.email : null;
  const emailVerified = payload.email_verified === true;

  if (provider === "agentid") {
    const local = email ? email.split("@")[0] : `agent-${payload.sub.slice(0, 8)}`;

    return {
      issuer: pending.issuer,
      subject: payload.sub,
      email,
      emailVerified,
      ownerEmail: typeof payload.owner_email === "string" ? payload.owner_email : null,
      name: typeof payload.name === "string" ? payload.name : local,
      handleHint: local,
      avatar: null,
      kind: "agent",
    };
  }

  const providerSub = typeof payload.provider_sub === "string" ? payload.provider_sub : "";
  const source = pending.provider === "google" ? "pid_google_" : "pid_passkey_";
  if (!providerSub.startsWith(source)) {
    throw new HttpError(
      400,
      `sign in with ${pending.provider === "google" ? "Google" : "a passkey"} to continue`,
      "wrong_identity_source",
    );
  }
  if (pending.provider === "google" && !(email && emailVerified)) {
    throw new HttpError(400, "a verified Google email is required", "email_required");
  }
  const preferred =
    typeof payload.preferred_username === "string" ? payload.preferred_username : null;
  const name = typeof payload.name === "string" ? payload.name : (preferred ?? email ?? "someone");

  return {
    issuer: pending.issuer,
    subject: payload.sub,
    email,
    emailVerified,
    ownerEmail: null,
    name,
    handleHint: preferred ?? email ?? name,
    avatar: typeof payload.picture === "string" ? payload.picture : null,
    kind: "human",
  };
}

async function uniqueHandle(base: string): Promise<string> {
  const data = db();
  const root = newHandleFor(base);
  if (await data.handleIsFree(root)) {
    return root;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${root}-${randomId(4).toLowerCase()}`;
    if (await data.handleIsFree(candidate)) {
      return candidate;
    }
  }
  throw new HttpError(500, "could not allocate a handle", "error");
}

async function finishLogin(
  c: Parameters<typeof principalOf>[0],
  provider: "triad" | "agentid",
): Promise<Response> {
  const env = appEnv();
  const state = c.req.query("state") ?? "";
  const pendingRaw = await env.KV.get(`login:${state}`);
  // SAFETY: login:<state> entries are written only by /auth/login with JSON.stringify(PendingLogin).
  const returnTo = pendingRaw
    ? safeReturnTo((JSON.parse(pendingRaw) as PendingLogin).returnTo)
    : "/";
  const verified = await exchange(c, provider);

  const data = db();
  const existing = await data.identity(verified.issuer, verified.subject);
  const user =
    existing?.user ??
    (await data.createUser({
      handle: await uniqueHandle(verified.handleHint),
      displayName: verified.name,
      kind: verified.kind,
      avatarUrl: verified.avatar,
      identity: {
        issuer: verified.issuer,
        subject: verified.subject,
        email: verified.email,
        emailVerified: verified.emailVerified,
        ownerEmail: verified.ownerEmail,
      },
    }));
  const session = await data.createSession(
    user.id,
    c.req.header("user-agent") ?? null,
    SESSION_TTL,
  );
  const secure = new URL(c.req.url).protocol === "https:";

  return new Response(null, {
    status: 302,
    headers: { location: returnTo, "set-cookie": sessionCookie(session, SESSION_TTL, secure) },
  });
}

auth.get("/callback/triad", (c) => finishLogin(c, "triad"));
auth.get("/callback/agentid", (c) => finishLogin(c, "agentid"));

auth.post("/logout", async (c) => {
  const sessionId = parseCookies(c.req.header("cookie") ?? null).get(SESSION_COOKIE);
  if (sessionId) {
    await db().deleteSession(sessionId);
  }
  const secure = new URL(c.req.url).protocol === "https:";

  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": sessionCookie("", 0, secure) },
  });
});

auth.get("/me", async (c) => {
  const principal = await principalOf(c);
  if (!principal) {
    throw new HttpError(401, "not signed in", "unauthorized");
  }
  const identities = await db().identitiesOf(principal.user.id);

  return c.json({
    user: {
      id: principal.user.id,
      handle: principal.user.handle,
      display_name: principal.user.display_name,
      kind: principal.user.kind,
      avatar_url: principal.user.avatar_url,
    },
    via: principal.via,
    scopes: [...principal.scopes],
    identities: identities.map((identity) => ({
      issuer: identity.issuer,
      email: identity.email,
      owner_email: identity.owner_email,
    })),
  });
});
