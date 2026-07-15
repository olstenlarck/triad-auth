import { AUTH_BASE_PATH, createTriadAuth } from "./better-auth/auth";
import { createTriadConfiguration } from "./better-auth/configuration";
import type { TriadEnv } from "./better-auth/env";

interface WorkerServices<Configuration> {
  createTriadConfiguration(env: TriadEnv): Configuration;
  createTriadAuth(
    env: TriadEnv,
    configuration: Configuration,
  ): { handler(request: Request): Response | Promise<Response> };
  handleAstro(request: Request, env: TriadEnv, context: ExecutionContext): Promise<Response>;
  fetchAssets(request: Request, env: TriadEnv): Promise<Response>;
}

export function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

export function createWorker<Configuration>(services: WorkerServices<Configuration>) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (isAuthPath(url.pathname)) {
        const configuration = services.createTriadConfiguration(env);

        return services.createTriadAuth(env, configuration).handler(request);
      }

      if (url.pathname.startsWith("/__astro_")) {
        return services.handleAstro(request, env, context);
      }

      return services.fetchAssets(request, env);
    },
  } satisfies ExportedHandler<TriadEnv>;
}

export default createWorker({
  createTriadConfiguration,
  createTriadAuth,
  async handleAstro(request, env, context) {
    const { handle } = await import("@astrojs/cloudflare/handler");

    return handle(request, env, context);
  },
  fetchAssets(request, env) {
    return env.ASSETS.fetch(request);
  },
});
