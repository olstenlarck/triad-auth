import { AUTH_BASE_PATH, createTriadAuth } from "./better-auth/auth";
import { createTriadConfiguration } from "./better-auth/configuration";
import type { TriadEnv } from "./better-auth/env";
import { createTriadResourceFragment } from "./better-auth/resources";

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

function protectedResourceDocument(url: URL, env: TriadEnv) {
  if (!url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return undefined;
  }

  const fragment = createTriadResourceFragment(env, {
    rpcWalletsResource: env.RPC_WALLETS_RESOURCE,
  });

  return fragment.protectedResourceMetadata.find(({ metadataUrl }) => metadataUrl === url.href)
    ?.document;
}

export function createWorker<Configuration>(services: WorkerServices<Configuration>) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      const resourceDocument = protectedResourceDocument(url, env);
      if (resourceDocument) {
        return Response.json(resourceDocument);
      }

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
