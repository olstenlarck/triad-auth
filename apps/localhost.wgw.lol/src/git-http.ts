import type { Context } from "hono";

import { hiddenPathsFor } from "./access";
import { type Access, type Principal, accessTo, authenticate } from "./auth";
import { appEnv, db, repoStub } from "./context";
import type { PathRule, RepoWithOwner } from "./db";
import type { PushSummary } from "./do/repo";

function unauthorized(message: string): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="localhost", charset="UTF-8"' },
  });
}

async function rateLimited(key: string): Promise<boolean> {
  const { success } = await appEnv().GIT_RATE_LIMIT.limit({ key });

  return !success;
}

// `owner/repo.public.git` is the read-only snapshot remote: private paths removed, one commit per branch.
export function parseRemoteName(name: string): { repoName: string; snapshot: boolean } {
  const bare = name.replace(/\.git$/, "");
  if (bare.endsWith(".public")) {
    return { repoName: bare.slice(0, -".public".length), snapshot: true };
  }

  return { repoName: bare, snapshot: false };
}

export function cloneUrls(
  repo: RepoWithOwner,
  rules: PathRule[],
  access: Access,
): { clone_url: string; public_clone_url: string | null } {
  const origin = appEnv().APP_ORIGIN;
  const full = `${origin}/${repo.owner_handle}/${repo.name}.git`;
  const hasPrivatePaths =
    repo.visibility === "public" && rules.some((rule) => rule.visibility === "private");
  if (!hasPrivatePaths) {
    return { clone_url: full, public_clone_url: null };
  }
  const snapshot = `${origin}/${repo.owner_handle}/${repo.name}.public.git`;

  return { clone_url: access.canReadPrivate ? full : snapshot, public_clone_url: snapshot };
}

// Routes git smart HTTP to the repository's Durable Object after checking visibility and tokens.
export async function handleGit(
  c: Context,
  owner: string,
  name: string,
  tail: string,
): Promise<Response> {
  const request = c.req.raw;
  const { repoName, snapshot } = parseRemoteName(name);
  const repo = await db().repo(owner, repoName);
  const principal = await authenticate(db(), request);
  if (!repo) {
    return principal
      ? new Response("repository not found\n", { status: 404 })
      : unauthorized("repository not found");
  }

  const access = await accessTo(db(), repo, principal);
  const isWrite =
    tail === "git-receive-pack" ||
    new URL(request.url).searchParams.get("service") === "git-receive-pack";
  if (!access.canRead) {
    return principal
      ? new Response("repository not found\n", { status: 404 })
      : unauthorized("authentication required");
  }
  if (isWrite && (snapshot || !access.canWrite)) {
    if (snapshot) {
      return new Response("the .public.git remote is read-only; push to the .git remote\n", {
        status: 403,
      });
    }

    return principal
      ? new Response("write access denied\n", { status: 403 })
      : unauthorized("authentication required");
  }
  if (
    await rateLimited(`git:${principal?.user.id ?? c.req.header("cf-connecting-ip") ?? "anon"}`)
  ) {
    return new Response("rate limited\n", { status: 429 });
  }

  const rules = await db().pathRules(repo.id);
  const anonymousView: Access = { ...access, role: null };
  const hidden = snapshot
    ? hiddenPathsFor(repo, rules, anonymousView)
    : hiddenPathsFor(repo, rules, access);
  // Git sends credentials only after a challenge. A repo with private paths must not hand an
  // unauthenticated collaborator the snapshot by accident, so the full remote demands credentials.
  if (!snapshot && !principal && hidden.length > 0) {
    return unauthorized(
      `this repository has private paths; clone ${repo.owner_handle}/${repo.name}.public.git or authenticate`,
    );
  }

  const headers = new Headers(request.headers);
  headers.set("x-lh-allow-write", access.canWrite && !snapshot ? "1" : "0");
  headers.set("x-lh-hidden", JSON.stringify(hidden));
  headers.set("x-lh-default-branch", repo.default_branch);
  const forwarded = new Request(`https://repo.internal/${tail}${new URL(request.url).search}`, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error duplex is required for streaming bodies in Workers
    duplex: "half",
  });
  const response = await repoStub(repo.id).fetch(forwarded);

  recordGitActivity(c, repo, principal, tail, response);

  return response;
}

function recordGitActivity(
  c: Context,
  repo: RepoWithOwner,
  principal: Principal | null,
  tail: string,
  response: Response,
): void {
  const env = appEnv();
  const operation =
    tail === "git-receive-pack" ? "push" : tail === "git-upload-pack" ? "fetch" : "advertise";
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [operation, repo.id, principal?.user.id ?? "anonymous"],
      doubles: [1],
      indexes: [repo.id],
    });
  } catch {
    // Analytics is best effort.
  }

  const pushHeader = response.headers.get("x-lh-push");
  if (operation !== "push" || !pushHeader || !principal) {
    return;
  }
  // SAFETY: the Durable Object writes this header itself with JSON.stringify of a PushSummary.
  const summary = JSON.parse(decodeURIComponent(pushHeader)) as PushSummary;
  if (summary.total === 0) {
    return;
  }
  c.executionCtx.waitUntil(
    Promise.all([
      db().updateRepo(repo.id, { pushed_at: Math.floor(Date.now() / 1000) }),
      env.EVENTS.send({
        type: "push",
        repoId: repo.id,
        actorId: principal.user.id,
        updates: summary.updates,
        objects: summary.objects,
      }),
    ]),
  );
}
