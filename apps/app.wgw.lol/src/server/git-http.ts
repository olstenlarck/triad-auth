import { Hono } from "hono";

import type { RefUpdate } from "../git/repo";
import { afterPush, repoStub } from "./api";
import { access, type AppContext, type AppEnv } from "./auth";
import { findRepo } from "./db";
import { HttpError } from "./util";

const AUTH_CHALLENGE = 'Basic realm="app.wgw.lol"';

function challenge(message: string): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { "www-authenticate": AUTH_CHALLENGE, "content-type": "text/plain" },
  });
}

async function resolveGit(c: AppContext, write: boolean) {
  const owner = c.req.param("owner") ?? "";
  const name = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const repo = await findRepo(c.env, owner, name);
  const principal = c.get("principal");
  if (repo === null) {
    return principal === null
      ? challenge("repository not found, or sign in")
      : new Response("repository not found\n", { status: 404 });
  }
  let grant;
  try {
    grant = await access(c, repo);
  } catch {
    return principal === null
      ? challenge("authentication required")
      : new Response("repository not found\n", { status: 404 });
  }
  if (write) {
    if (principal === null) {
      return challenge("pushing needs an API token as the password");
    }
    if (grant.role === null || grant.role === "read" || !principal.scopes.has("write")) {
      return new Response(`no write access to ${repo.owner}/${repo.name}\n`, { status: 403 });
    }
  }
  return grant;
}

/** Git smart HTTP. The Worker checks access; the repository's Durable Object speaks the protocol. */
export const gitHttp = new Hono<AppEnv>();

gitHttp.get("/:owner/:repo/info/refs", async (c) => {
  const service = c.req.query("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    throw new HttpError(403, "this server speaks smart HTTP only; use git 2.x", "invalid_request");
  }
  const grant = await resolveGit(c, service === "git-receive-pack");
  if (grant instanceof Response) {
    return grant;
  }
  return repoStub(c.env, grant.repo.id).fetch(
    new Request(`https://repo/info/refs?service=${service}`, {
      headers: { "x-wgw-view": grant.view },
    }),
  );
});

gitHttp.post("/:owner/:repo/git-upload-pack", async (c) => {
  const grant = await resolveGit(c, false);
  if (grant instanceof Response) {
    return grant;
  }
  const headers = new Headers({ "x-wgw-view": grant.view });
  const encoding = c.req.header("content-encoding");
  if (encoding !== undefined) {
    headers.set("content-encoding", encoding);
  }
  const response = await repoStub(c.env, grant.repo.id).fetch(
    new Request("https://repo/git-upload-pack", { method: "POST", headers, body: c.req.raw.body }),
  );
  c.env.METRICS.writeDataPoint({
    blobs: ["fetch", `${grant.repo.owner}/${grant.repo.name}`, grant.view],
    doubles: [1],
    indexes: [grant.repo.id],
  });
  return response;
});

gitHttp.post("/:owner/:repo/git-receive-pack", async (c) => {
  const grant = await resolveGit(c, true);
  if (grant instanceof Response) {
    return grant;
  }
  const headers = new Headers({ "x-wgw-view": "full" });
  const encoding = c.req.header("content-encoding");
  if (encoding !== undefined) {
    headers.set("content-encoding", encoding);
  }
  const response = await repoStub(c.env, grant.repo.id).fetch(
    new Request("https://repo/git-receive-pack", { method: "POST", headers, body: c.req.raw.body }),
  );
  const updates: RefUpdate[] = JSON.parse(response.headers.get("x-wgw-updates") ?? "[]");
  c.executionCtx.waitUntil(afterPush(c.env, grant.repo, grant.principal?.user.id ?? null, updates));
  const out = new Headers(response.headers);
  out.delete("x-wgw-updates");
  return new Response(response.body, { status: response.status, headers: out });
});
