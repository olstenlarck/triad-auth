import type { Env, ProviderIdentity } from "./types";

interface ProviderStart {
  url: string;
}

const callback = (env: Env) => `${env.ISSUER}/callback/github`;

export function startProvider(env: Env, state: string): ProviderStart {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callback(env),
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

async function githubUserId(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": "triad-auth" },
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
  const user = await response.json<{ id?: number }>();
  if (!Number.isSafeInteger(user.id)) throw new Error("GitHub response missing numeric id");
  return String(user.id);
}

export async function finishProvider(env: Env, code: string): Promise<ProviderIdentity> {
  const id = await (async () => {
    const token = await tokenRequest("https://github.com/login/oauth/access_token", new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: callback(env),
    }));
    if (typeof token.access_token !== "string") throw new Error("GitHub response missing access token");
    return githubUserId(token.access_token);
  })();
  return { provider: "github", id };
}
