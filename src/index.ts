import { Hono } from "hono";
import { createAuth } from "./auth";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  if (c.req.path.startsWith("/api/auth/")) {
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
  }
});

app.get("/", c =>
  c.json({
    service: "Triad Auth",
    implementation: "better-auth",
    issuer: c.env.BETTER_AUTH_URL,
    discovery: [
      new URL("/api/auth/.well-known/openid-configuration", c.env.BETTER_AUTH_URL).toString(),
      new URL(
        "/api/auth/.well-known/oauth-authorization-server",
        c.env.BETTER_AUTH_URL,
      ).toString(),
    ],
  }),
);

app.get("/health", c => c.json({ ok: true }));

app.get("/login", c => {
  const returnTo = c.req.query("returnTo") ?? "/";
  const providers = ["google", "github", "twitter"]
    .filter(provider => Boolean(c.env[`${provider.toUpperCase()}_CLIENT_ID` as keyof Env]))
    .map(
      provider =>
        `<li><a href="/api/auth/sign-in/social?provider=${provider}&callbackURL=${encodeURIComponent(returnTo)}">${provider}</a></li>`,
    )
    .join("");

  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Triad Auth</title><main><h1>Sign in</h1><ul>${providers}</ul></main>`,
  );
});

app.on(["GET", "POST"], "/api/auth/*", c => createAuth(c.env).handler(c.req.raw));

app.onError((error, c) => {
  console.error("request failed", error);
  return c.json({ error: "server_error" }, 500);
});

export default app;
