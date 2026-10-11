import { Hono } from "hono";

import authMd from "../../AUTH.md?raw";
import llmsTxt from "../../llms.txt?raw";
import skillMd from "../../SKILL.md?raw";
import { SESSION_COOKIE } from "../auth";
import { appEnv, db } from "../context";
import { handleGit } from "../git-http";
import { isValidSlug } from "../utils";
import { agentAuth } from "./agent-auth";
import { auth, clientMetadataDocument } from "./auth";
import { HttpError, problem, publicRepo } from "./http";
import { repos } from "./repos";
import { user } from "./user";

export const app = new Hono();

// Cookie-authenticated mutations must come from our own origin. Bearer requests skip this check.
app.use("*", async (c, next) => {
  const method = c.req.method;
  const hasCookie = (c.req.header("cookie") ?? "").includes(`${SESSION_COOKIE}=`);
  const hasBearer = (c.req.header("authorization") ?? "").length > 0;
  if (method !== "GET" && method !== "HEAD" && hasCookie && !hasBearer) {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const sameOrigin =
      origin === appEnv().APP_ORIGIN || (origin === undefined && site === "same-origin");
    if (!sameOrigin) {
      return problem(c, 403, "cross-site request blocked", "csrf");
    }
  }

  return next();
});

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return problem(c, error.status, error.message, error.code);
  }
  console.error(error);

  return problem(c, 500, "internal error", "internal");
});

app.get("/healthz", (c) => c.json({ ok: true, commit: appEnv().COMMIT_SHA }));
app.get("/oauth-client.json", (c) => c.json(clientMetadataDocument()));
app.get("/auth.md", (c) => c.text(authMd, 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/skill.md", (c) =>
  c.text(skillMd, 200, { "content-type": "text/markdown; charset=utf-8" }),
);
app.get("/llms.txt", (c) => c.text(llmsTxt, 200, { "content-type": "text/plain; charset=utf-8" }));

app.route("/auth", auth);
app.route("/", agentAuth);
app.route("/api/user", user);
app.route("/api/repos", repos);

app.get("/api/users/:handle", async (c) => {
  const found = await db().userByHandle(c.req.param("handle"));
  if (!found) {
    throw new HttpError(404, "user not found", "not_found");
  }
  const list = (await db().reposOwnedBy(found.id)).filter((repo) => repo.visibility === "public");

  return c.json({
    user: {
      handle: found.handle,
      display_name: found.display_name,
      kind: found.kind,
      avatar_url: found.avatar_url,
      created_at: found.created_at,
    },
    repos: list.map(publicRepo),
  });
});

app.get("/api", (c) =>
  c.json({
    name: "localhost",
    docs: {
      skill: `${appEnv().APP_ORIGIN}/skill.md`,
      auth: `${appEnv().APP_ORIGIN}/auth.md`,
      llms: `${appEnv().APP_ORIGIN}/llms.txt`,
    },
    endpoints: [
      "/api/user",
      "/api/user/tokens",
      "/api/repos",
      "/api/repos/:owner/:repo",
      "/oauth2/device_authorization",
      "/oauth2/token",
    ],
  }),
);

// Smart HTTP: /:owner/:repo.git/info/refs, /git-upload-pack, /git-receive-pack
app.all("/:owner/:repo{[^/]+\\.git}/:tail{.+}", (c) =>
  handleGit(c, c.req.param("owner"), c.req.param("repo"), c.req.param("tail")),
);
app.all("/:owner/:repo{[^/]+\\.git}", (c) => {
  const url = new URL(c.req.url);
  if (
    !(isValidSlug(c.req.param("owner")) && isValidSlug(c.req.param("repo").replace(/\.git$/, "")))
  ) {
    return problem(c, 404, "not found", "not_found");
  }

  return c.redirect(
    `/${c.req.param("owner")}/${c.req.param("repo").replace(/\.git$/, "")}${url.search}`,
    302,
  );
});

app.notFound((c) => problem(c, 404, "not found", "not_found"));
