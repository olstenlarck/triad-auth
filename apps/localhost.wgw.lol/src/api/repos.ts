import { type Context, Hono } from "hono";

import { exposedPathsFor, hiddenPathsFor, pathIsExposed } from "../access";
import { appEnv, db, personFor, repoStub } from "../context";
import { decryptText, encryptText } from "../crypto";
import type { Db, PathRule, Role } from "../db";
import type { RepoObject } from "../do/repo";
import { cloneUrls } from "../git-http";
import { isValidSlug } from "../utils";
import {
  type AccessLevel,
  HttpError,
  loadRepo,
  publicRepo,
  readJson,
  type RepoContext,
  requirePrincipal,
  type WriterContext,
} from "./http";

export const repos = new Hono();

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
// Imports fetch arbitrary packfiles into the Durable Object, so the source host list stays short.
const IMPORT_HOSTS = ["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"];

function importSourceAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    IMPORT_HOSTS.includes(url.hostname) &&
    /^\/[^/]+\/[^/]+/.test(url.pathname)
  );
}

function cleanRef(value: string | undefined, fallback: string): string {
  const ref = (value ?? "").trim();
  if (!ref) {
    return fallback;
  }
  if (!(BRANCH.test(ref) || /^[0-9a-f]{4,40}$/.test(ref))) {
    throw new HttpError(400, "invalid ref", "invalid_request");
  }

  return ref;
}

// Branch names only: a bare sha would otherwise create refs/heads/<sha> on write.
function cleanBranch(value: string | undefined, fallback: string): string {
  const branch = cleanRef(value, fallback);
  if (/^[0-9a-f]{40}$/.test(branch) || !BRANCH.test(branch)) {
    throw new HttpError(400, "branch must be a branch name", "invalid_request");
  }

  return branch;
}

type RepoView<T extends RepoContext> = T & {
  rules: PathRule[];
  hidden: string[];
  exposed: string[] | null;
  stub: DurableObjectStub<RepoObject>;
};

function viewFor(c: Context, level: "write" | "admin"): Promise<RepoView<WriterContext>>;
function viewFor(c: Context, level: AccessLevel): Promise<RepoView<RepoContext>>;

async function viewFor(c: Context, level: AccessLevel): Promise<RepoView<RepoContext>> {
  const context = await loadRepo(c, level);
  const rules = await db().pathRules(context.repo.id);
  const hidden = hiddenPathsFor(context.repo, rules, context.access);
  const exposed = exposedPathsFor(context.repo, rules, context.access);

  return { ...context, rules, hidden, exposed, stub: repoStub(context.repo.id) };
}

// Splits `<ref>/<path>` from a tree, blob, or raw URL. Branch names may contain slashes, so the
// longest leading run of segments that names an existing branch or tag wins; otherwise the first
// segment is taken as a sha or unknown ref.
async function splitRefAndPath(
  stub: ReturnType<typeof repoStub>,
  raw: string,
  fallback: string,
): Promise<{ ref: string; path: string }> {
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ref: fallback, path: "" };
  }
  const refs = await stub.refs();
  const names = new Set([...refs.branches, ...refs.tags].map((entry) => entry.name));
  for (let length = segments.length; length > 0; length--) {
    const candidate = segments.slice(0, length).join("/");
    if (names.has(candidate)) {
      return { ref: candidate, path: segments.slice(length).join("/") };
    }
  }

  return { ref: cleanRef(segments[0], fallback), path: segments.slice(1).join("/") };
}

// ---- repositories ----

repos.get("/", async (c) => {
  const principal = await requirePrincipal(c).catch(() => null);
  const reader = principal?.scopes.has("repo:read") ? principal.user.id : null;
  const list = await db().reposVisibleTo(reader);

  return c.json({ repos: list.map(publicRepo) });
});

repos.post("/", async (c) => {
  const principal = await requirePrincipal(c);
  if (!principal.scopes.has("repo:admin")) {
    throw new HttpError(403, "repo:admin scope required", "forbidden");
  }
  const body = await readJson<{
    name?: string;
    description?: string;
    visibility?: string;
    default_branch?: string;
    import_from?: string;
  }>(c);
  const name = (body.name ?? "").trim();
  if (name.endsWith(".public")) {
    throw new HttpError(
      400,
      "names ending in .public are reserved for snapshot remotes",
      "invalid_request",
    );
  }
  if (!isValidSlug(name)) {
    throw new HttpError(
      400,
      "name must be 1-64 characters of letters, digits, dot, dash, or underscore",
      "invalid_request",
    );
  }
  if (await db().repo(principal.user.handle, name)) {
    throw new HttpError(409, "a repository with that name exists", "conflict");
  }
  const visibility = body.visibility === "private" ? "private" : "public";
  const defaultBranch = cleanRef(body.default_branch, "master");
  const importFrom = body.import_from?.trim() || null;
  if (importFrom && !importSourceAllowed(importFrom)) {
    throw new HttpError(
      400,
      `import_from must be an https URL on ${IMPORT_HOSTS.join(", ")}`,
      "invalid_request",
    );
  }

  const repo = await db().createRepo({
    ownerId: principal.user.id,
    name,
    description: (body.description ?? "").slice(0, 500),
    visibility,
    defaultBranch,
    importedFrom: importFrom,
  });
  const stub = repoStub(repo.id);
  await stub.setDefaultBranch(defaultBranch);
  if (importFrom) {
    await stub.startImport(importFrom);
  }
  c.executionCtx.waitUntil(
    appEnv().EVENTS.send(
      importFrom
        ? { type: "repo.imported", repoId: repo.id, actorId: principal.user.id, remote: importFrom }
        : { type: "repo.created", repoId: repo.id, actorId: principal.user.id },
    ),
  );
  const created = await db().repoById(repo.id);

  return c.json(
    {
      repo: created ? publicRepo(created) : null,
      clone_url: `${appEnv().APP_ORIGIN}/${principal.user.handle}/${name}.git`,
    },
    201,
  );
});

repos.get("/:owner/:repo", async (c) => {
  const { repo, access, stub, rules } = await viewFor(c, "read");
  const [refs, stats, importProgress] = await Promise.all([
    stub.refs(),
    stub.stats(),
    stub.importProgress(),
  ]);
  if (repo.import_status === "running" && importProgress.status !== "running") {
    // The import adopted the remote's HEAD; D1 follows it so protection and the UI agree.
    const imported = refs.head.replace(/^refs\/heads\//, "");
    const defaultBranch = refs.branches.some((branch) => branch.name === imported)
      ? imported
      : repo.default_branch;
    await db().updateRepo(repo.id, {
      import_status: importProgress.status,
      default_branch: defaultBranch,
    });
    repo.default_branch = defaultBranch;
  }

  return c.json({
    repo: publicRepo(repo),
    ...cloneUrls(repo, rules, access),
    permissions: {
      role: access.role,
      read: access.canRead,
      write: access.canWrite,
      admin: access.canAdmin,
    },
    refs,
    stats,
    import: importProgress,
    path_rules: access.role ? rules : [],
  });
});

repos.patch("/:owner/:repo", async (c) => {
  const { repo, stub } = await viewFor(c, "admin");
  const body = await readJson<{
    description?: string;
    visibility?: string;
    default_branch?: string;
  }>(c);
  const patch: Parameters<Db["updateRepo"]>[1] = {};
  if (typeof body.description === "string") {
    patch.description = body.description.slice(0, 500);
  }
  if (body.visibility === "public" || body.visibility === "private") {
    patch.visibility = body.visibility;
  }
  if (typeof body.default_branch === "string") {
    const branch = cleanRef(body.default_branch, repo.default_branch);
    const refs = await stub.refs();
    if (!refs.branches.some((candidate) => candidate.name === branch)) {
      throw new HttpError(400, "branch does not exist", "invalid_request");
    }
    patch.default_branch = branch;
    await stub.setDefaultBranch(branch);
  }
  await db().updateRepo(repo.id, patch);
  const updated = await db().repoById(repo.id);

  return c.json({ repo: updated ? publicRepo(updated) : null });
});

repos.delete("/:owner/:repo", async (c) => {
  const { repo, stub } = await viewFor(c, "admin");
  await stub.destroy();
  await db().deleteRepo(repo.id);

  return c.body(null, 204);
});

// ---- git data ----

repos.get("/:owner/:repo/refs", async (c) => {
  const { stub } = await viewFor(c, "read");

  return c.json(await stub.refs());
});

repos.get("/:owner/:repo/commits", async (c) => {
  const { repo, stub } = await viewFor(c, "read");
  const ref = cleanRef(c.req.query("ref"), repo.default_branch);
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 200);
  const skip = Math.max(Number(c.req.query("skip") ?? 0) || 0, 0);

  return c.json({ ref, commits: await stub.history(ref, limit, skip) });
});

repos.get("/:owner/:repo/commits/:sha", async (c) => {
  const { stub, hidden } = await viewFor(c, "read");
  const sha = await stub.resolve(c.req.param("sha"));
  if (!sha) {
    throw new HttpError(404, "commit not found", "not_found");
  }
  const commit = await stub.commit(sha);
  const changes = commit ? await stub.changesOf(sha, { hidden }) : [];

  return c.json({ commit, changes });
});

repos.get("/:owner/:repo/tree/:ref{.+}", async (c) => {
  const { repo, stub, hidden, exposed } = await viewFor(c, "exposed");
  const { ref, path } = await splitRefAndPath(stub, c.req.param("ref"), repo.default_branch);
  if (exposed && !pathIsExposed(path, exposed, "directory")) {
    throw new HttpError(404, "not found", "not_found");
  }
  const entries = await stub.listPath(ref, path, { hidden });
  if (!entries) {
    throw new HttpError(404, "path not found", "not_found");
  }
  const filtered = exposed
    ? entries.filter((entry) =>
        pathIsExposed(
          path ? `${path}/${entry.name}` : entry.name,
          exposed,
          entry.kind === "dir" ? "directory" : "file",
        ),
      )
    : entries;

  return c.json({ ref, path, entries: filtered });
});

repos.get("/:owner/:repo/blob/:ref{.+}", async (c) => {
  const { repo, stub, hidden, exposed } = await viewFor(c, "exposed");
  const { ref, path } = await splitRefAndPath(stub, c.req.param("ref"), repo.default_branch);
  if (exposed && !pathIsExposed(path, exposed, "file")) {
    throw new HttpError(404, "not found", "not_found");
  }
  const file = await stub.readFile(ref, path, { hidden });
  if (!file) {
    throw new HttpError(404, "file not found", "not_found");
  }

  return c.json({ ref, ...file });
});

repos.get("/:owner/:repo/raw/:ref{.+}", async (c) => {
  const { repo, stub, hidden, exposed, rules } = await viewFor(c, "exposed");
  const { ref, path } = await splitRefAndPath(stub, c.req.param("ref"), repo.default_branch);
  if (exposed && !pathIsExposed(path, exposed, "file")) {
    throw new HttpError(404, "not found", "not_found");
  }
  const raw = await stub.rawFile(ref, path, { hidden });
  if (!raw) {
    throw new HttpError(404, "file not found", "not_found");
  }

  return new Response(raw.data, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control":
        repo.visibility === "public" && rules.length === 0
          ? "public, max-age=60"
          : "private, no-store",
      etag: `"${raw.sha}"`,
    },
  });
});

repos.put("/:owner/:repo/contents/:path{.+}", async (c) => {
  const { stub, principal, repo } = await viewFor(c, "write");
  const body = await readJson<{ content?: string; message?: string; branch?: string }>(c);
  if (typeof body.content !== "string") {
    throw new HttpError(400, "content is required", "invalid_request");
  }
  const branch = cleanBranch(body.branch, repo.default_branch);
  const result = await stub.writeFile(
    branch,
    c.req.param("path"),
    body.content,
    personFor(principal),
    body.message?.trim() || `Update ${c.req.param("path")}`,
  );
  await db().updateRepo(repo.id, { pushed_at: Math.floor(Date.now() / 1000) });

  return c.json({ branch, commit: result.sha });
});

repos.delete("/:owner/:repo/contents/:path{.+}", async (c) => {
  const { stub, principal, repo } = await viewFor(c, "write");
  const body = await readJson<{ message?: string; branch?: string }>(c).catch(() => null);
  const branch = cleanBranch(body?.branch, repo.default_branch);
  const result = await stub.writeFile(
    branch,
    c.req.param("path"),
    null,
    personFor(principal),
    body?.message?.trim() || `Delete ${c.req.param("path")}`,
  );

  return c.json({ branch, commit: result.sha });
});

repos.post("/:owner/:repo/branches", async (c) => {
  const { stub, repo } = await viewFor(c, "write");
  const body = await readJson<{ name?: string; from?: string }>(c);
  const name = cleanBranch(body.name, "");
  if (!name) {
    throw new HttpError(400, "name is required", "invalid_request");
  }
  const created = await stub.createBranch(name, cleanRef(body.from, repo.default_branch));
  if (!created) {
    throw new HttpError(409, "branch exists or source ref not found", "conflict");
  }

  return c.json({ branch: name }, 201);
});

repos.delete("/:owner/:repo/branches/:name{.+}", async (c) => {
  const { stub, repo } = await viewFor(c, "write");
  const name = c.req.param("name");
  if (name === repo.default_branch) {
    throw new HttpError(400, "cannot delete the default branch", "invalid_request");
  }
  if (!(await stub.deleteBranch(name))) {
    throw new HttpError(404, "branch not found", "not_found");
  }

  return c.body(null, 204);
});

repos.get("/:owner/:repo/compare/:spec{.+}", async (c) => {
  const { stub, hidden, repo } = await viewFor(c, "read");
  const [base, head] = c.req.param("spec").split("...");
  const result = await stub.compare(
    cleanRef(base, repo.default_branch),
    cleanRef(head, repo.default_branch),
    { hidden },
  );
  if (!result) {
    throw new HttpError(404, "ref not found", "not_found");
  }

  return c.json(result);
});

// ---- pull requests ----

repos.get("/:owner/:repo/pulls", async (c) => {
  const { repo } = await viewFor(c, "read");
  const state = c.req.query("state");
  const list = await db().pullRequests(
    repo.id,
    state === "open" || state === "merged" || state === "closed" ? state : undefined,
  );

  return c.json({ pulls: list });
});

repos.post("/:owner/:repo/pulls", async (c) => {
  const { repo, stub, principal } = await viewFor(c, "write");
  const body = await readJson<{
    title?: string;
    body?: string;
    base?: string;
    head?: string;
    ai_summary?: boolean;
  }>(c);
  const title = (body.title ?? "").trim().slice(0, 200);
  const base = cleanRef(body.base, repo.default_branch);
  const head = cleanRef(body.head, "");
  if (!title || !head) {
    throw new HttpError(400, "title and head are required", "invalid_request");
  }
  const refs = await stub.refs();
  const exists = (name: string) => refs.branches.some((branch) => branch.name === name);
  if (!(exists(base) && exists(head))) {
    throw new HttpError(400, "base and head must be existing branches", "invalid_request");
  }
  const pr = await db().createPullRequest({
    repoId: repo.id,
    title,
    body: (body.body ?? "").slice(0, 20_000),
    authorId: principal.user.id,
    baseRef: base,
    headRef: head,
  });
  c.executionCtx.waitUntil(
    appEnv().EVENTS.send({
      type: "pull_request.opened",
      repoId: repo.id,
      actorId: principal.user.id,
      number: pr.number,
      title,
    }),
  );

  return c.json({ pull: await db().pullRequest(repo.id, pr.number) }, 201);
});

repos.get("/:owner/:repo/pulls/:number", async (c) => {
  const { repo, stub, hidden } = await viewFor(c, "read");
  const pr = await db().pullRequest(repo.id, Number(c.req.param("number")));
  if (!pr) {
    throw new HttpError(404, "pull request not found", "not_found");
  }
  const compare =
    pr.state === "open" ? await stub.compare(pr.base_ref, pr.head_ref, { hidden }) : null;
  const comments = await db().comments(pr.id);

  return c.json({ pull: pr, compare, comments });
});

repos.post("/:owner/:repo/pulls/:number/comments", async (c) => {
  const { repo, principal } = await viewFor(c, "read");
  if (!principal) {
    throw new HttpError(401, "authentication required", "unauthorized");
  }
  if (!principal.scopes.has("repo:write")) {
    throw new HttpError(403, "repo:write scope required to comment", "forbidden");
  }
  const pr = await db().pullRequest(repo.id, Number(c.req.param("number")));
  if (!pr) {
    throw new HttpError(404, "pull request not found", "not_found");
  }
  const body = await readJson<{ body?: string }>(c);
  const text = (body.body ?? "").trim();
  if (!text) {
    throw new HttpError(400, "body is required", "invalid_request");
  }
  await db().addComment(pr.id, principal.user.id, text.slice(0, 10_000));

  return c.json({ comments: await db().comments(pr.id) }, 201);
});

repos.post("/:owner/:repo/pulls/:number/merge", async (c) => {
  const { repo, stub, principal } = await viewFor(c, "write");
  const pr = await db().pullRequest(repo.id, Number(c.req.param("number")));
  if (!pr) {
    throw new HttpError(404, "pull request not found", "not_found");
  }
  if (pr.state !== "open") {
    throw new HttpError(409, `pull request is ${pr.state}`, "conflict");
  }
  const message = `Merge pull request #${pr.number} from ${pr.head_ref}\n\n${pr.title}\n`;
  const outcome = await stub.merge(pr.base_ref, pr.head_ref, personFor(principal), message);
  if (outcome.status === "error") {
    throw new HttpError(400, outcome.message, "invalid_request");
  }
  if (outcome.status === "conflict") {
    return c.json({ merged: false, status: "conflict", conflicts: outcome.conflicts }, 409);
  }
  if (outcome.status === "up-to-date") {
    return c.json(
      {
        merged: false,
        status: "up-to-date",
        message: "the base branch already contains the head branch",
      },
      409,
    );
  }
  await db().updatePullRequest(pr.id, {
    state: "merged",
    merge_sha: outcome.sha,
    merged_at: Math.floor(Date.now() / 1000),
  });
  await db().updateRepo(repo.id, { pushed_at: Math.floor(Date.now() / 1000) });
  c.executionCtx.waitUntil(
    appEnv().EVENTS.send({
      type: "pull_request.merged",
      repoId: repo.id,
      actorId: principal.user.id,
      number: pr.number,
      title: pr.title,
    }),
  );

  return c.json({ merged: true, status: outcome.status, sha: outcome.sha });
});

repos.post("/:owner/:repo/pulls/:number/close", async (c) => {
  const { repo, principal } = await viewFor(c, "write");
  const pr = await db().pullRequest(repo.id, Number(c.req.param("number")));
  if (!pr || pr.state !== "open") {
    throw new HttpError(404, "open pull request not found", "not_found");
  }
  await db().updatePullRequest(pr.id, { state: "closed" });
  c.executionCtx.waitUntil(
    appEnv().EVENTS.send({
      type: "pull_request.closed",
      repoId: repo.id,
      actorId: principal.user.id,
      number: pr.number,
      title: pr.title,
    }),
  );

  return c.json({ closed: true });
});

// Workers AI drafts a summary of the diff; the author decides whether to keep it.
repos.post("/:owner/:repo/pulls/:number/summarize", async (c) => {
  const { repo, stub, rules } = await viewFor(c, "write");
  // The summary is readable by everyone who can see the pull request, so it is built from the
  // public view: private paths never reach the model.
  const hidden = rules.filter((rule) => rule.visibility === "private").map((rule) => rule.pattern);
  const pr = await db().pullRequest(repo.id, Number(c.req.param("number")));
  if (!pr) {
    throw new HttpError(404, "pull request not found", "not_found");
  }
  const compare = await stub.compare(pr.base_ref, pr.head_ref, { hidden });
  const excerpt = (compare?.changes ?? [])
    .slice(0, 12)
    .map(
      (change) =>
        `## ${change.status} ${change.path}\n${(change.newText ?? change.oldText ?? "").slice(0, 1500)}`,
    )
    .join("\n\n")
    .slice(0, 12_000);
  const commits = (compare?.commits ?? [])
    .map((commit) => `- ${commit.message.split("\n")[0]}`)
    .join("\n");
  const prompt = `You review pull requests. Write a plain 3-5 sentence summary of what this change does and anything risky. No headings, no bullet points, no praise.\n\nTitle: ${pr.title}\n\nCommits:\n${commits}\n\nChanged files:\n${excerpt}`;
  // SAFETY: @cf/meta/llama-3.1-8b-instruct-fast postdates the AiModels catalogue in workers-types, so the
  // model id and its chat input go through untyped; text generation answers with { response }.
  const result = (await appEnv().AI.run(
    "@cf/meta/llama-3.1-8b-instruct-fast" as never,
    {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    } as never,
  )) as { response?: string };
  const summary = (result.response ?? "").trim();
  await db().updatePullRequest(pr.id, { ai_summary: summary });

  return c.json({ summary });
});

// ---- environments and secrets ----

repos.get("/:owner/:repo/environments", async (c) => {
  const { repo, access, principal } = await viewFor(c, "read");
  if (!access.role || !principal?.scopes.has("env:read")) {
    throw new HttpError(403, "env:read scope and a repository role are required", "forbidden");
  }
  const environments = await db().environments(repo.id);
  const detailed = await Promise.all(
    environments.map(async (environment) => ({
      name: environment.name,
      created_at: environment.created_at,
      vars: (await db().envVars(environment.id)).map((variable) => ({
        key: variable.key,
        secret: variable.is_secret === 1,
        updated_at: variable.updated_at,
      })),
    })),
  );

  return c.json({ environments: detailed });
});

repos.put("/:owner/:repo/environments/:name", async (c) => {
  const { repo, principal } = await viewFor(c, "write");
  if (!principal?.scopes.has("env:write")) {
    throw new HttpError(403, "env:write scope required", "forbidden");
  }
  const name = c.req.param("name");
  if (!isValidSlug(name)) {
    throw new HttpError(400, "invalid environment name", "invalid_request");
  }
  const environment = await db().createEnvironment(repo.id, name);

  return c.json(
    { environment: { name: environment.name, created_at: environment.created_at } },
    201,
  );
});

repos.delete("/:owner/:repo/environments/:name", async (c) => {
  const { repo, principal } = await viewFor(c, "admin");
  if (!principal?.scopes.has("env:write")) {
    throw new HttpError(403, "env:write scope required", "forbidden");
  }
  await db().deleteEnvironment(repo.id, c.req.param("name"));

  return c.body(null, 204);
});

// Values come back decrypted only with env:read on a token or session that has a role on the repo.
repos.get("/:owner/:repo/environments/:name/vars", async (c) => {
  const { repo, access, principal } = await viewFor(c, "read");
  if (!access.role || !principal?.scopes.has("env:read")) {
    throw new HttpError(403, "env:read scope and a repository role are required", "forbidden");
  }
  const environment = await db().environment(repo.id, c.req.param("name"));
  if (!environment) {
    throw new HttpError(404, "environment not found", "not_found");
  }
  const reveal = c.req.query("reveal") === "1";
  const vars = await Promise.all(
    (await db().envVars(environment.id)).map(async (variable) => ({
      key: variable.key,
      secret: variable.is_secret === 1,
      value:
        reveal || variable.is_secret === 0
          ? await decryptText(appEnv().ENCRYPTION_KEY, variable.value_enc)
          : null,
      updated_at: variable.updated_at,
    })),
  );

  return c.json({ environment: environment.name, vars });
});

repos.put("/:owner/:repo/environments/:name/vars/:key", async (c) => {
  const { repo, principal } = await viewFor(c, "write");
  if (!principal?.scopes.has("env:write")) {
    throw new HttpError(403, "env:write scope required", "forbidden");
  }
  const key = c.req.param("key");
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) {
    throw new HttpError(400, "keys are UPPER_SNAKE_CASE", "invalid_request");
  }
  const body = await readJson<{ value?: string; secret?: boolean }>(c);
  if (typeof body.value !== "string") {
    throw new HttpError(400, "value is required", "invalid_request");
  }
  const environment = await db().createEnvironment(repo.id, c.req.param("name"));
  await db().setEnvVar(
    environment.id,
    key,
    await encryptText(appEnv().ENCRYPTION_KEY, body.value),
    body.secret !== false,
  );

  return c.json({ key, secret: body.secret !== false });
});

repos.delete("/:owner/:repo/environments/:name/vars/:key", async (c) => {
  const { repo, principal } = await viewFor(c, "write");
  if (!principal?.scopes.has("env:write")) {
    throw new HttpError(403, "env:write scope required", "forbidden");
  }
  const environment = await db().environment(repo.id, c.req.param("name"));
  if (environment) {
    await db().deleteEnvVar(environment.id, c.req.param("key"));
  }

  return c.body(null, 204);
});

// ---- path visibility rules ----

repos.get("/:owner/:repo/visibility", async (c) => {
  const { repo, rules, access } = await viewFor(c, "read");
  if (!access.role) {
    throw new HttpError(403, "a repository role is required", "forbidden");
  }

  return c.json({
    visibility: repo.visibility,
    rules: rules.map((rule) => ({ pattern: rule.pattern, visibility: rule.visibility })),
  });
});

repos.put("/:owner/:repo/visibility/rules", async (c) => {
  const { repo } = await viewFor(c, "admin");
  const body = await readJson<{ pattern?: string; visibility?: string }>(c);
  const pattern = (body.pattern ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!pattern || pattern.includes("..") || pattern.length > 200) {
    throw new HttpError(400, "pattern must be a repository path prefix", "invalid_request");
  }
  if (body.visibility !== "public" && body.visibility !== "private") {
    throw new HttpError(400, "visibility must be public or private", "invalid_request");
  }
  await db().setPathRule(repo.id, pattern, body.visibility);

  return c.json({
    rules: (await db().pathRules(repo.id)).map((rule) => ({
      pattern: rule.pattern,
      visibility: rule.visibility,
    })),
  });
});

repos.delete("/:owner/:repo/visibility/rules/:pattern{.+}", async (c) => {
  const { repo } = await viewFor(c, "admin");
  await db().deletePathRule(repo.id, c.req.param("pattern"));

  return c.body(null, 204);
});

// ---- collaborators ----

repos.get("/:owner/:repo/collaborators", async (c) => {
  const { repo, access } = await viewFor(c, "read");
  if (!access.role) {
    throw new HttpError(403, "a repository role is required", "forbidden");
  }

  return c.json({ owner: repo.owner_handle, collaborators: await db().collaborators(repo.id) });
});

repos.put("/:owner/:repo/collaborators/:handle", async (c) => {
  const { repo } = await viewFor(c, "admin");
  const body = await readJson<{ role?: Role }>(c);
  const role = body.role ?? "write";
  if (!["read", "write", "admin"].includes(role)) {
    throw new HttpError(400, "role must be read, write, or admin", "invalid_request");
  }
  const user = await db().userByHandle(c.req.param("handle"));
  if (!user) {
    throw new HttpError(404, "user not found", "not_found");
  }
  await db().setCollaborator(repo.id, user.id, role);

  return c.json({ collaborators: await db().collaborators(repo.id) });
});

repos.delete("/:owner/:repo/collaborators/:handle", async (c) => {
  const { repo } = await viewFor(c, "admin");
  const user = await db().userByHandle(c.req.param("handle"));
  if (user) {
    await db().removeCollaborator(repo.id, user.id);
  }

  return c.body(null, 204);
});

// ---- activity ----

repos.get("/:owner/:repo/events", async (c) => {
  const { repo } = await viewFor(c, "read");

  return c.json({ events: await db().events(repo.id, 50) });
});

export { accessTo } from "../auth";
