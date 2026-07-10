import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomToken, sha256 } from "./crypto";
import type { Env, ProviderIdentity, ProviderName } from "./types";

interface ProviderStart {
  url: string;
  verifier?: string;
  nonce?: string;
}

interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const callback = (provider: ProviderName, env: Env) => `${env.ISSUER}/callback/${provider}`;

const configured = (clientId?: string, clientSecret?: string) =>
  Boolean(clientId?.trim() && clientSecret?.trim());

const formEncode = (value: string) =>
  new URLSearchParams({ value }).toString().slice("value=".length);

function providerCredentials(provider: ProviderName, env: Env): ProviderCredentials {
  const [clientId, clientSecret] = provider === "google"
    ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
    : provider === "twitter"
      ? [env.TWITTER_CLIENT_ID, env.TWITTER_CLIENT_SECRET]
      : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
  if (!clientId?.trim() || !clientSecret?.trim()) throw new Error(`${provider} provider is not configured`);
  return { clientId, clientSecret };
}

export function enabledProviders(env: Env): ProviderName[] {
  const providers: ProviderName[] = [];
  if (configured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) providers.push("google");
  if (configured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) providers.push("github");
  if (configured(env.TWITTER_CLIENT_ID, env.TWITTER_CLIENT_SECRET)) providers.push("twitter");
  return providers;
}

export async function startProvider(provider: ProviderName, env: Env, state: string): Promise<ProviderStart> {
  const { clientId } = providerCredentials(provider, env);
  if (provider === "google") {
    const nonce = randomToken();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback(provider, env),
      response_type: "code",
      scope: "openid",
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
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback(provider, env),
    state,
  }).toString();
  return { url: url.toString() };
}

async function tokenRequest(url: string, body: URLSearchParams, headers?: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body,
  });
  if (!response.ok) throw new Error(`provider token exchange failed (${response.status})`);
  return response.json<Record<string, unknown>>();
}

async function githubUserId(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": "triad-auth" },
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
  const user = await response.json<{ id?: number }>();
  if (!Number.isSafeInteger(user.id)) throw new Error("GitHub response missing numeric id");
  return String(user.id);
}

async function finishGoogle(
  env: Env,
  credentials: ProviderCredentials,
  code: string,
  nonce?: string,
): Promise<string> {
  if (!nonce) throw new Error("Google nonce is required");
  const token = await tokenRequest("https://oauth2.googleapis.com/token", new URLSearchParams({
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: callback("google", env),
    grant_type: "authorization_code",
  }));
  if (typeof token.id_token !== "string") throw new Error("Google response missing ID token");
  const { payload } = await jwtVerify(token.id_token, googleJwks, {
    algorithms: ["RS256"],
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: credentials.clientId,
    requiredClaims: ["exp", "iat"],
  });
  if (payload.nonce !== nonce) throw new Error("Google ID token nonce mismatch");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Google ID token missing subject");
  }
  return payload.sub;
}

async function finishGitHub(env: Env, credentials: ProviderCredentials, code: string): Promise<string> {
  const token = await tokenRequest("https://github.com/login/oauth/access_token", new URLSearchParams({
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: callback("github", env),
  }));
  if (typeof token.access_token !== "string") throw new Error("GitHub response missing access token");
  return githubUserId(token.access_token);
}

async function finishTwitter(
  env: Env,
  credentials: ProviderCredentials,
  code: string,
  verifier?: string,
): Promise<string> {
  if (!verifier) throw new Error("Twitter PKCE verifier is required");
  const basicCredentials = `${formEncode(credentials.clientId)}:${formEncode(credentials.clientSecret)}`;
  const token = await tokenRequest("https://api.x.com/2/oauth2/token", new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: callback("twitter", env),
    code_verifier: verifier,
  }), { authorization: `Basic ${btoa(basicCredentials)}` });
  if (typeof token.access_token !== "string") throw new Error("Twitter response missing access token");

  const response = await fetch("https://api.x.com/2/users/me", {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Twitter user lookup failed (${response.status})`);
  const user = await response.json<{ data?: { id?: unknown } }>();
  if (typeof user.data?.id !== "string" || !/^[1-9][0-9]*$/.test(user.data.id)) {
    throw new Error("Twitter response missing valid data.id");
  }
  return user.data.id;
}

export async function finishProvider(
  provider: ProviderName,
  env: Env,
  code: string,
  verifier?: string,
  nonce?: string,
): Promise<ProviderIdentity> {
  const credentials = providerCredentials(provider, env);
  const id = provider === "google"
    ? await finishGoogle(env, credentials, code, nonce)
    : provider === "twitter"
      ? await finishTwitter(env, credentials, code, verifier)
      : await finishGitHub(env, credentials, code);
  return { provider, id };
}
