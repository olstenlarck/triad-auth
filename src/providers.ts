import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomToken, sha256 } from "./crypto";
import type { Env, ProviderIdentity, ProviderName } from "./types";

interface ProviderStart {
  url: string;
  verifier?: string;
  nonce?: string;
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const callback = (env: Env, provider: ProviderName) => `${env.ISSUER}/callback/${provider}`;

export async function startProvider(
  provider: ProviderName,
  env: Env,
  state: string,
): Promise<ProviderStart> {
  if (provider === "google") {
    const nonce = randomToken();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: callback(env, provider),
      response_type: "code",
      scope: "openid",
      state,
      nonce,
    }).toString();
    return { url: url.toString(), nonce };
  }

  if (provider === "github") {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: callback(env, provider),
      state,
    }).toString();
    return { url: url.toString() };
  }

  const verifier = randomToken(48);
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: env.X_CLIENT_ID,
    redirect_uri: callback(env, provider),
    response_type: "code",
    scope: "users.read tweet.read",
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), verifier };
}

async function tokenRequest(url: string, body: URLSearchParams, headers?: HeadersInit) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body,
  });
  if (!response.ok) throw new Error(`provider token exchange failed (${response.status})`);
  return response.json<Record<string, unknown>>();
}

export async function finishProvider(
  provider: ProviderName,
  env: Env,
  code: string,
  verifier?: string | null,
  nonce?: string | null,
): Promise<ProviderIdentity> {
  if (provider === "google") {
    const token = await tokenRequest("https://oauth2.googleapis.com/token", new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callback(env, provider),
      grant_type: "authorization_code",
    }));
    if (typeof token.id_token !== "string") throw new Error("Google response missing id_token");
    const { payload: claims } = await jwtVerify(token.id_token, googleJwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.GOOGLE_CLIENT_ID,
    });
    if (typeof claims.sub !== "string" || !nonce || claims.nonce !== nonce) {
      throw new Error("invalid Google identity token");
    }
    return { provider, id: claims.sub };
  }

  if (provider === "github") {
    const token = await tokenRequest("https://github.com/login/oauth/access_token", new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: callback(env, provider),
    }));
    if (typeof token.access_token !== "string") throw new Error("GitHub response missing access token");
    const response = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "triad-auth" },
    });
    if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
    const user = await response.json<{ id?: number }>();
    if (!Number.isSafeInteger(user.id)) throw new Error("GitHub response missing numeric id");
    return { provider, id: String(user.id) };
  }

  if (!verifier) throw new Error("X PKCE verifier missing");
  const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  const token = await tokenRequest("https://api.x.com/2/oauth2/token", new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: callback(env, provider),
    code_verifier: verifier,
  }), { authorization: `Basic ${basic}` });
  if (typeof token.access_token !== "string") throw new Error("X response missing access token");
  const response = await fetch("https://api.x.com/2/users/me", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!response.ok) throw new Error(`X user lookup failed (${response.status})`);
  const user = await response.json<{ data?: { id?: string } }>();
  if (typeof user.data?.id !== "string") throw new Error("X response missing user id");
  return { provider, id: user.data.id };
}
