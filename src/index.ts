import { AUTH_BASE_PATH, createTriadAuth } from "./better-auth/auth";
import { createTriadConfiguration } from "./better-auth/configuration";
import { canonicalDisclosureScopes } from "./better-auth/disclosures";
import type { TriadEnv } from "./better-auth/env";
import { createTriadResourceFragment } from "./better-auth/resources";

interface TriadAuthService {
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
  };
  handler(request: Request): Response | Promise<Response>;
}

interface WorkerServices<Configuration> {
  createTriadConfiguration(env: TriadEnv): Configuration;
  createTriadAuth(env: TriadEnv, configuration: Configuration): TriadAuthService;
  handleAstro(request: Request, env: TriadEnv, context: ExecutionContext): Promise<Response>;
  fetchAssets(request: Request, env: TriadEnv): Promise<Response>;
}

interface DeviceDisclosureRecord {
  scope: string | null;
}

const DEVICE_DISCLOSURE_PATH = `${AUTH_BASE_PATH}/device/disclosure`;

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

async function handleDeviceDisclosure(
  request: Request,
  env: TriadEnv,
  auth: TriadAuthService,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }

  const url = new URL(request.url);
  const userCodes = url.searchParams.getAll("user_code");
  const userCode = userCodes.length === 1 ? userCodes[0]!.replaceAll("-", "").toUpperCase() : "";
  if (!/^[A-Z0-9]{8}$/.test(userCode)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const record = await env.DB.prepare(
    'select "scope" from "deviceCode" where "userCode" = ? and "userId" = ? and "status" = \'pending\'',
  )
    .bind(userCode, session.user.id)
    .first<DeviceDisclosureRecord>();
  if (!record) {
    return Response.json({ error: "invalid_request" }, { status: 404 });
  }

  let scopes;
  try {
    scopes = canonicalDisclosureScopes(record.scope?.split(" ") ?? []);
  } catch {
    return Response.json({ error: "invalid_scope" }, { status: 400 });
  }

  return Response.json(
    { scopes },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

export function createWorker<Configuration>(services: WorkerServices<Configuration>) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      const resourceDocument = protectedResourceDocument(url, env);
      if (resourceDocument) {
        return Response.json(resourceDocument);
      }

      if (url.pathname === DEVICE_DISCLOSURE_PATH) {
        const configuration = services.createTriadConfiguration(env);
        const auth = services.createTriadAuth(env, configuration);

        return handleDeviceDisclosure(request, env, auth);
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
