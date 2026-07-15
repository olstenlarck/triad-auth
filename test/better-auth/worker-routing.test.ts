import { describe, expect, it, vi } from "vite-plus/test";

import type { TriadEnv } from "../../src/better-auth/env";
import { createWorker, isAuthPath } from "../../src/index";

const env = {} as TriadEnv;
const context = {} as ExecutionContext;

function createServices() {
  const calls: string[] = [];
  const configuration = { application: "triad" };

  const authHandler = vi.fn(() => new Response("auth"));
  const getSession = vi.fn(async () => null);
  const createTriadConfiguration = vi.fn(() => {
    calls.push("configuration");

    return configuration;
  });
  const createTriadAuth = vi.fn((_env: TriadEnv, receivedConfiguration: typeof configuration) => {
    calls.push("auth");
    expect(receivedConfiguration).toBe(configuration);

    return { api: { getSession }, handler: authHandler };
  });
  const handleAstro = vi.fn(async () => {
    calls.push("astro");

    return new Response("astro");
  });
  const fetchAssets = vi.fn(async () => {
    calls.push("assets");

    return new Response("assets");
  });

  return {
    calls,
    configuration,
    services: {
      createTriadConfiguration,
      createTriadAuth,
      handleAstro,
      fetchAssets,
    },
    spies: {
      createTriadConfiguration,
      createTriadAuth,
      authHandler,
      getSession,
      handleAstro,
      fetchAssets,
    },
  };
}

describe("isAuthPath", () => {
  it.each([
    ["/api/auth", true],
    ["/api/auth/session", true],
    ["/api/authentic", false],
    ["/api/auth-example/session", false],
    ["/", false],
  ])("matches %s: %s", (pathname, expected) => {
    expect(isAuthPath(pathname)).toBe(expected);
  });
});

describe("Triad Worker routing", () => {
  it.each(["/api/auth", "/api/auth/session"])(
    "routes %s through configuration and auth only",
    async (pathname) => {
      const { calls, configuration, services, spies } = createServices();
      const worker = createWorker(services);
      const request = new Request(`https://auth.example.com${pathname}`) as Parameters<
        typeof worker.fetch
      >[0];

      const response = await worker.fetch(request, env, context);

      expect(await response.text()).toBe("auth");
      expect(calls).toEqual(["configuration", "auth"]);
      expect(spies.createTriadConfiguration).toHaveBeenCalledWith(env);
      expect(spies.createTriadAuth).toHaveBeenCalledWith(env, configuration);
      expect(spies.authHandler).toHaveBeenCalledWith(request);
      expect(spies.handleAstro).not.toHaveBeenCalled();
      expect(spies.fetchAssets).not.toHaveBeenCalled();
    },
  );

  it("routes an auth-like path through assets only", async () => {
    const { calls, services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/api/authentic") as Parameters<
      typeof worker.fetch
    >[0];

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("assets");
    expect(calls).toEqual(["assets"]);
    expect(spies.fetchAssets).toHaveBeenCalledWith(request, env);
    expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
    expect(spies.createTriadAuth).not.toHaveBeenCalled();
    expect(spies.authHandler).not.toHaveBeenCalled();
    expect(spies.handleAstro).not.toHaveBeenCalled();
  });

  it("routes Astro internals through Astro only", async () => {
    const { calls, services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/__astro_page") as Parameters<
      typeof worker.fetch
    >[0];

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("astro");
    expect(calls).toEqual(["astro"]);
    expect(spies.handleAstro).toHaveBeenCalledWith(request, env, context);
    expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
    expect(spies.createTriadAuth).not.toHaveBeenCalled();
    expect(spies.authHandler).not.toHaveBeenCalled();
    expect(spies.fetchAssets).not.toHaveBeenCalled();
  });
});
