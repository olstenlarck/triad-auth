import { afterEach, describe, expect, it, vi } from "vitest";
import { finishProvider, startProvider } from "../src/providers";
import type { Env } from "../src/types";

const env = {
  ISSUER: "https://auth.example",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("GitHub provider", () => {
  it("starts GitHub authorization without requesting profile scopes", () => {
    const { url } = startProvider(env, "upstream-state");
    const target = new URL(url);

    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: "github-client",
      redirect_uri: "https://auth.example/callback/github",
      state: "upstream-state",
    });
    expect(target.searchParams.has("scope")).toBe(false);
  });

  it("requests only GitHub identity and returns the immutable numeric id", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary", token_type: "bearer", scope: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "mutable-name" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(finishProvider(env, "provider-code")).resolves.toEqual({ provider: "github", id: "42" });

    const tokenRequest = fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenRequest[0]).toBe("https://github.com/login/oauth/access_token");
    expect(new Headers(tokenRequest[1].headers).get("accept")).toBe("application/json");
    expect(String(tokenRequest[1].body)).toBe(new URLSearchParams({
      code: "provider-code",
      client_id: "github-client",
      client_secret: "github-secret",
      redirect_uri: "https://auth.example/callback/github",
    }).toString());

    const identityRequest = fetch.mock.calls[1] as [string, RequestInit];
    expect(identityRequest[0]).toBe("https://api.github.com/user");
    const identityHeaders = new Headers(identityRequest[1].headers);
    expect(identityHeaders.get("authorization")).toBe("Bearer temporary");
    expect(identityHeaders.get("accept")).toBe("application/json");
    expect(identityHeaders.get("user-agent")).toBe("triad-auth");
  });

  it.each([NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null])("rejects an unsafe GitHub id: %s", async (id) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id }), { status: 200 })));

    await expect(finishProvider(env, "provider-code")).rejects.toThrow("numeric id");
  });
});
