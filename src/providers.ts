import { createRemoteJWKSet, jwtVerify } from "jose";
import { validateProviderScopes } from "./claims";
import { randomToken, sha256 } from "./crypto";
import type {
  Env,
  ProfileClaims,
  ProfileScope,
  ProviderIdentity,
  ProviderName,
  Scope,
} from "./types";

interface ProviderStart {
  url: string;
  verifier?: string;
  nonce?: string;
}

interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

interface ProviderResult {
  id: string;
  claims: ProfileClaims;
}

const providerLabels: Record<ProviderName, string> = {
  google: "Google",
  github: "GitHub",
  twitter: "Twitter",
};

export class MandatoryProfileValueError extends Error {
  readonly name = "MandatoryProfileValueError";

  constructor(
    readonly provider: ProviderName,
    readonly scope: ProfileScope,
    claim: string = scope,
  ) {
    super(`${providerLabels[provider]} response missing mandatory ${claim} claim`);
  }
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const callback = (provider: ProviderName, env: Env) =>
  `${env.PROVIDER_CALLBACK_ORIGIN ?? env.ISSUER}/callback/${provider}`;

const configured = (clientId?: string, clientSecret?: string) =>
  Boolean(clientId?.trim() && clientSecret?.trim());

const formEncode = (value: string) =>
  new URLSearchParams({ value }).toString().slice("value=".length);

function providerCredentials(provider: ProviderName, env: Env): ProviderCredentials {
  const [clientId, clientSecret] =
    provider === "google"
      ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
      : provider === "twitter"
        ? [env.TWITTER_CLIENT_ID, env.TWITTER_CLIENT_SECRET]
        : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];

  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new Error(`${provider} provider is not configured`);
  }

  return { clientId, clientSecret };
}

export function enabledProviders(env: Env): ProviderName[] {
  const providers: ProviderName[] = [];
  if (configured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) {
    providers.push("google");
  }
  if (configured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) {
    providers.push("github");
  }
  if (configured(env.TWITTER_CLIENT_ID, env.TWITTER_CLIENT_SECRET)) {
    providers.push("twitter");
  }

  return providers;
}

export async function startProvider(
  provider: ProviderName,
  env: Env,
  state: string,
  scopes: readonly Scope[] = ["openid"],
): Promise<ProviderStart> {
  const { clientId } = providerCredentials(provider, env);

  validateProviderScopes(provider, scopes);

  if (provider === "google") {
    const nonce = randomToken();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback(provider, env),
      response_type: "code",
      scope: [
        "openid",
        ...(scopes.includes("email") ? ["email"] : []),
        ...(scopes.some((scope) => scope === "name" || scope === "avatar") ? ["profile"] : []),
      ].join(" "),
      state,
      nonce,
    }).toString();

    return { url: url.toString(), nonce };
  }

  if (provider === "twitter") {
    const verifier = randomToken();
    const url = new URL("https://x.com/i/oauth2/authorize");

    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback(provider, env),
      scope: "tweet.read users.read",
      state,
      code_challenge: await sha256(verifier),
      code_challenge_method: "S256",
    }).toString();

    return { url: url.toString(), verifier };
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback(provider, env),
    state,
  });

  if (scopes.includes("email")) {
    params.set("scope", "user:email");
  }

  url.search = params.toString();

  return { url: url.toString() };
}

async function tokenRequest(url: string, body: URLSearchParams, headers?: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...headers,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`provider token exchange failed (${response.status})`);
  }

  return response.json<Record<string, unknown>>();
}

async function finishGoogle(
  env: Env,
  credentials: ProviderCredentials,
  code: string,
  nonce?: string,
  scopes: readonly Scope[] = ["openid"],
): Promise<ProviderResult> {
  if (!nonce) {
    throw new Error("Google nonce is required");
  }

  const token = await tokenRequest(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: callback("google", env),
      grant_type: "authorization_code",
    }),
  );

  if (typeof token.id_token !== "string") {
    throw new Error("Google response missing ID token");
  }

  const { payload } = await jwtVerify(token.id_token, googleJwks, {
    algorithms: ["RS256"],
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: credentials.clientId,
    requiredClaims: ["exp", "iat"],
  });

  if (payload.nonce !== nonce) {
    throw new Error("Google ID token nonce mismatch");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Google ID token missing subject");
  }

  const claims: ProfileClaims = {};

  if (scopes.includes("email")) {
    claims.email = mandatoryString("google", "email", payload.email);
    if (typeof payload.email_verified !== "boolean") {
      throw new MandatoryProfileValueError("google", "email", "email_verified");
    }
    claims.email_verified = payload.email_verified;
  }
  if (scopes.includes("name")) {
    claims.name = mandatoryString("google", "name", payload.name);
  }
  if (scopes.includes("avatar")) {
    claims.picture = mandatoryString("google", "avatar", payload.picture);
  }

  return { id: payload.sub, claims };
}

function mandatoryString(provider: ProviderName, scope: ProfileScope, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MandatoryProfileValueError(provider, scope);
  }

  return value;
}

const githubHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
  accept: "application/json",
  "user-agent": "triad-auth",
});

async function finishGitHub(
  env: Env,
  credentials: ProviderCredentials,
  code: string,
  scopes: readonly Scope[] = ["openid"],
): Promise<ProviderResult> {
  const token = await tokenRequest(
    "https://github.com/login/oauth/access_token",
    new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: callback("github", env),
    }),
  );

  if (typeof token.access_token !== "string") {
    throw new Error("GitHub response missing access token");
  }

  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token.access_token),
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed (${response.status})`);
  }

  const user = await response.json<{
    id?: unknown;
    login?: unknown;
    name?: unknown;
    avatar_url?: unknown;
  }>();

  if (!Number.isSafeInteger(user.id)) {
    throw new Error("GitHub response missing numeric id");
  }

  const claims: ProfileClaims = {};

  if (scopes.includes("handle")) {
    claims.preferred_username = mandatoryString("github", "handle", user.login);
  }
  if (scopes.includes("name")) {
    claims.name = mandatoryString("github", "name", user.name);
  }
  if (scopes.includes("avatar")) {
    claims.picture = mandatoryString("github", "avatar", user.avatar_url);
  }
  if (scopes.includes("email")) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers: githubHeaders(token.access_token),
    });

    if (!emailsResponse.ok) {
      throw new Error(`GitHub email lookup failed (${emailsResponse.status})`);
    }

    const emails = await emailsResponse.json<unknown>();
    const primary = Array.isArray(emails)
      ? emails.find(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>).primary === true &&
            (entry as Record<string, unknown>).verified === true,
        )
      : undefined;

    claims.email = mandatoryString(
      "github",
      "email",
      primary && (primary as Record<string, unknown>).email,
    );

    claims.email_verified = true;
  }

  return { id: String(user.id), claims };
}

async function finishTwitter(
  env: Env,
  credentials: ProviderCredentials,
  code: string,
  verifier?: string,
  scopes: readonly Scope[] = ["openid"],
): Promise<ProviderResult> {
  if (!verifier) {
    throw new Error("Twitter PKCE verifier is required");
  }

  const basicCredentials = `${formEncode(credentials.clientId)}:${formEncode(credentials.clientSecret)}`;
  const token = await tokenRequest(
    "https://api.x.com/2/oauth2/token",
    new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: callback("twitter", env),
      code_verifier: verifier,
    }),
    { authorization: `Basic ${btoa(basicCredentials)}` },
  );

  if (typeof token.access_token !== "string") {
    throw new Error("Twitter response missing access token");
  }

  const url = new URL("https://api.x.com/2/users/me");
  const fields = [
    ...(scopes.includes("handle") ? ["username"] : []),
    ...(scopes.includes("name") ? ["name"] : []),
    ...(scopes.includes("avatar") ? ["profile_image_url"] : []),
  ];

  if (fields.length > 0) {
    url.searchParams.set("user.fields", fields.join(","));
  }

  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Twitter user lookup failed (${response.status})`);
  }

  const user = await response.json<{
    data?: {
      id?: unknown;
      username?: unknown;
      name?: unknown;
      profile_image_url?: unknown;
    };
  }>();

  if (typeof user.data?.id !== "string" || !/^[1-9][0-9]*$/.test(user.data.id)) {
    throw new Error("Twitter response missing valid data.id");
  }

  const claims: ProfileClaims = {};

  if (scopes.includes("handle")) {
    claims.preferred_username = mandatoryString("twitter", "handle", user.data.username);
  }
  if (scopes.includes("name")) {
    claims.name = mandatoryString("twitter", "name", user.data.name);
  }
  if (scopes.includes("avatar")) {
    claims.picture = mandatoryString("twitter", "avatar", user.data.profile_image_url);
  }

  return { id: user.data.id, claims };
}

export async function finishProvider(
  provider: ProviderName,
  env: Env,
  code: string,
  verifier?: string,
  nonce?: string,
  scopes: readonly Scope[] = ["openid"],
): Promise<ProviderIdentity> {
  const credentials = providerCredentials(provider, env);

  validateProviderScopes(provider, scopes);

  const result =
    provider === "google"
      ? await finishGoogle(env, credentials, code, nonce, scopes)
      : provider === "twitter"
        ? await finishTwitter(env, credentials, code, verifier, scopes)
        : await finishGitHub(env, credentials, code, scopes);

  return Object.keys(result.claims).length > 0
    ? { provider, id: result.id, claims: result.claims }
    : { provider, id: result.id };
}
