import { app } from "../api";
import { currentRequest } from "../request-context";
import { isRecord } from "../utils";
import type { ApiResult, Json } from "./server";

// Server only: this module reaches the Hono app and the request context. The server functions in
// server.ts import it dynamically inside their handlers, which keeps it out of the client bundle.

// Loaders call the REST API in-process with the browser's cookies, so the UI and agents share one API.
export async function relay(path: string): Promise<ApiResult<Json>> {
  const { request, env, ctx } = currentRequest();
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  headers.set("origin", env.APP_ORIGIN);
  const response = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, { method: "GET", headers }),
    env,
    ctx,
  );
  const text = await response.text();
  let parsed: Json | null = null;
  try {
    // SAFETY: the body comes from our own REST API, which answers JSON documents.
    parsed = text ? (JSON.parse(text) as Json) : null;
  } catch {
    parsed = null;
  }
  const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : null;

  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? parsed : null,
    error: response.ok ? null : (message ?? `request failed with ${response.status}`),
  };
}

export function buildInfo(): { commit: string } {
  return { commit: currentRequest().env.COMMIT_SHA };
}
