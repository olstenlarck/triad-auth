import type { Env, ProviderIdentity, ProviderName } from "./types";

interface ProviderStart {
  url: string;
  verifier?: string;
  nonce?: string;
}

const callback = (env: Env, provider: ProviderName) => `${env.ISSUER}/callback/${provider}`;

export async function startProvider(
  provider: ProviderName,
  env: Env,
  state: string,
): Promise<ProviderStart> {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callback(env, provider),
    state,
  }).toString();
  return { url: url.toString() };
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
