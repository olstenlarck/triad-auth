import { createServerFn } from "@tanstack/react-start";

import { app } from "../api";
import { currentRequest } from "../request-context";
import { isRecord } from "../utils";

// A JSON document as the REST API returns it. Server functions may only carry serializable data.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

// Loaders call the REST API in-process with the browser's cookies, so the UI and agents share one API.
async function relay<T>(path: string): Promise<ApiResult<T>> {
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
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : null;

  // SAFETY: `path` names one of our own REST routes, and the caller names the JSON shape it answers with.
  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? (parsed as T) : null,
    error: response.ok ? null : (message ?? `request failed with ${response.status}`),
  };
}

const apiGet = createServerFn({ method: "GET" })
  .validator((path: string) => path)
  .handler(({ data }) => relay<Json>(data));

// Loaders name the payload type of the endpoint they call once, here.
export async function callApi<T>(path: string): Promise<ApiResult<T>> {
  const result: ApiResult<unknown> = await apiGet({ data: path });

  // SAFETY: the server function relays our own REST API unchanged; the caller names the JSON shape of `path`.
  return result as ApiResult<T>;
}

export interface SessionUser {
  handle: string;
  display_name: string;
  kind: "human" | "agent";
  avatar_url: string | null;
}

export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  const result = await relay<{ user: SessionUser }>("/auth/me");

  return result.data?.user ?? null;
});

export function buildInfo(): { commit: string } {
  return { commit: currentRequest().env.COMMIT_SHA };
}

export const getBuildInfo = createServerFn({ method: "GET" }).handler(() => buildInfo());
