import { createServerFn } from "@tanstack/react-start";

// A JSON document as the REST API returns it. Server functions may only carry serializable data.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export interface SessionUser {
  handle: string;
  display_name: string;
  kind: "human" | "agent";
  avatar_url: string | null;
}

// Handler bodies run only on the server, so the dynamic import of ./relay never reaches the browser.
const apiGet = createServerFn({ method: "GET" })
  .validator((path: string) => path)
  .handler(async ({ data }) => {
    const { relay } = await import("./relay");

    return relay(data);
  });

// Loaders name the payload type of the endpoint they call once, here.
export async function callApi<T>(path: string): Promise<ApiResult<T>> {
  const result: ApiResult<unknown> = await apiGet({ data: path });

  // SAFETY: the server function relays our own REST API unchanged; the caller names the JSON shape of `path`.
  return result as ApiResult<T>;
}

export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  const { relay } = await import("./relay");
  const result = await relay("/auth/me");
  const user =
    result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data.user
      : null;

  // SAFETY: /auth/me answers { user: SessionUser } when signed in.
  return (user ?? null) as SessionUser | null;
});

export const getBuildInfo = createServerFn({ method: "GET" }).handler(async () => {
  const { buildInfo } = await import("./relay");

  return buildInfo();
});
