import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { type Access, type Principal, accessTo, authenticate } from "../auth";
import { db } from "../context";
import type { RepoWithOwner } from "../db";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function problem(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  code = "error",
): Response {
  const response = c.json({ error: code, message }, status);
  if (status === 401) {
    response.headers.set(
      "www-authenticate",
      `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource"`,
    );
  }

  return response;
}

export async function principalOf(c: Context): Promise<Principal | null> {
  return authenticate(db(), c.req.raw);
}

export async function requirePrincipal(c: Context): Promise<Principal> {
  const principal = await principalOf(c);
  if (!principal) {
    throw new HttpError(401, "authentication required", "unauthorized");
  }

  return principal;
}

// "exposed" admits anonymous viewers to a private repository that has public path rules.
export type AccessLevel = "exposed" | "read" | "write" | "admin";

export interface RepoContext {
  repo: RepoWithOwner;
  principal: Principal | null;
  access: Access;
}

// Write and admin access need a role on the repository, and a role needs a signed-in principal.
export interface WriterContext extends RepoContext {
  principal: Principal;
}

export function loadRepo(c: Context, level: "write" | "admin"): Promise<WriterContext>;
export function loadRepo(c: Context, level: AccessLevel): Promise<RepoContext>;
export async function loadRepo(c: Context, level: AccessLevel): Promise<RepoContext> {
  const owner = c.req.param("owner") ?? "";
  const name = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const repo = await db().repo(owner, name);
  const principal = await principalOf(c);
  if (!repo) {
    throw new HttpError(404, "repository not found", "not_found");
  }
  const access = await accessTo(db(), repo, principal);
  const exposedOnly =
    level === "exposed" &&
    !access.canRead &&
    (await db().pathRules(repo.id)).some((rule) => rule.visibility === "public");
  if (!(access.canRead || exposedOnly)) {
    // Signed-in callers get the same 404 as a missing repo, so private names do not leak.
    if (principal) {
      throw new HttpError(404, "repository not found", "not_found");
    }
    throw new HttpError(401, "authentication required", "unauthorized");
  }
  if (level === "write" && !access.canWrite) {
    throw new HttpError(403, "write access required", "forbidden");
  }
  if (level === "admin" && !access.canAdmin) {
    throw new HttpError(403, "admin access required", "forbidden");
  }

  return { repo, principal, access };
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "request body must be JSON", "invalid_request");
  }
}

// OAuth endpoints take application/x-www-form-urlencoded; a body that does not parse reads as an empty form.
export async function readForm(c: Context): Promise<Record<string, string | File | undefined>> {
  try {
    return await c.req.parseBody();
  } catch {
    return {};
  }
}

export function publicRepo(repo: RepoWithOwner) {
  return {
    id: repo.id,
    owner: repo.owner_handle,
    name: repo.name,
    full_name: `${repo.owner_handle}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    default_branch: repo.default_branch,
    imported_from: repo.imported_from,
    import_status: repo.import_status,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}
