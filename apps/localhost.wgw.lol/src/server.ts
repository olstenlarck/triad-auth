import handler from "@tanstack/react-start/server-entry";

import { app } from "./api";
import type { QueueEvent } from "./events";
import { consume } from "./queue";
import { requestContext } from "./request-context";

export { RepoObject } from "./do/repo";

// Raw protocol routes (git, REST, OAuth, agent auth, well-known) go to Hono first; the UI gets the rest.
const RAW_PREFIXES = ["/api/", "/auth/", "/agent/", "/oauth2/", "/.well-known/"];
const RAW_FILES = new Set([
  "/api",
  "/auth.md",
  "/skill.md",
  "/llms.txt",
  "/oauth-client.json",
  "/healthz",
]);

function isRaw(url: URL): boolean {
  if (
    RAW_FILES.has(url.pathname) ||
    RAW_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    return true;
  }

  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(url.pathname);
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function harden(response: Response): Response {
  const hardened = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    hardened.headers.set(name, value);
  }

  return hardened;
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const response = await requestContext.run({ request, env, ctx }, () =>
      isRaw(url) ? app.fetch(request, env, ctx) : handler.fetch(request),
    );

    return harden(response);
  },
  queue(batch: MessageBatch<QueueEvent>): Promise<void> {
    return consume(batch);
  },
} satisfies ExportedHandler<AppEnv, QueueEvent>;
