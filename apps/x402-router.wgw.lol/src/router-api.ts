import { fetch as routerFetch } from "@tunnckocore/x402-router";

const HEALTH_PATHS = new Set(["/health", "/healthz"]);

// The router package answers health checks; the app adds the commit it was built from.
export async function routerApi(request: Request): Promise<Response> {
  const response = await routerFetch(request);
  if (
    request.method !== "GET" ||
    !response.ok ||
    !HEALTH_PATHS.has(new URL(request.url).pathname)
  ) {
    return response;
  }

  // SAFETY: the router answers health checks with a JSON object, checked by response.ok above.
  const body = (await response.json()) as Record<string, unknown>;

  return new Response(JSON.stringify({ ...body, commit: import.meta.env.COMMIT_SHA }), response);
}
