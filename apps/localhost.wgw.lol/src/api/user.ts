import { Hono } from "hono";

import { SCOPES, isScope, newToken } from "../auth";
import { db } from "../context";
import { now } from "../utils";
import { HttpError, publicRepo, readJson, requirePrincipal } from "./http";

export const user = new Hono();

user.get("/", async (c) => {
  const principal = await requirePrincipal(c);
  const repos = await db().reposOwnedBy(principal.user.id);

  return c.json({
    user: {
      id: principal.user.id,
      handle: principal.user.handle,
      display_name: principal.user.display_name,
      kind: principal.user.kind,
      avatar_url: principal.user.avatar_url,
    },
    scopes: [...principal.scopes],
    repos: repos.map(publicRepo),
  });
});

user.get("/tokens", async (c) => {
  const principal = await requirePrincipal(c);
  const tokens = await db().tokensOf(principal.user.id);

  return c.json({
    tokens: tokens.map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes.split(" "),
      repo_id: token.repo_id,
      expires_at: token.expires_at,
      last_used_at: token.last_used_at,
      created_at: token.created_at,
    })),
  });
});

// Only a browser session may mint tokens, so a leaked token cannot mint more.
user.post("/tokens", async (c) => {
  const principal = await requirePrincipal(c);
  if (principal.via !== "session") {
    throw new HttpError(
      403,
      "tokens are created from a signed-in browser session or the device flow",
      "forbidden",
    );
  }
  const body = await readJson<{ name?: string; scopes?: string[]; expires_in_days?: unknown }>(c);
  const name = (body.name ?? "").trim().slice(0, 60) || "token";
  const scopes = (body.scopes ?? [...SCOPES]).filter(isScope);
  if (scopes.length === 0) {
    throw new HttpError(400, `scopes must be from: ${SCOPES.join(", ")}`, "invalid_request");
  }
  const requestedDays = body.expires_in_days === undefined ? 90 : Number(body.expires_in_days);
  const days =
    Number.isFinite(requestedDays) && requestedDays >= 0 ? Math.min(requestedDays, 365) : 90;
  const created = newToken();
  const token = await db().createToken({
    userId: principal.user.id,
    name,
    prefix: created.prefix,
    hash: created.hash,
    scopes,
    expiresAt: days > 0 ? now() + days * 86_400 : null,
  });

  return c.json(
    { id: token.id, token: created.plaintext, scopes, expires_at: token.expires_at },
    201,
  );
});

user.delete("/tokens/:id", async (c) => {
  const principal = await requirePrincipal(c);
  if (!(await db().deleteToken(principal.user.id, c.req.param("id")))) {
    throw new HttpError(404, "token not found", "not_found");
  }

  return c.body(null, 204);
});
