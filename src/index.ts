import { Hono } from "hono";
import { createAuth } from "./auth";
import { consentPage } from "./consent";
import type { Env } from "./env";
import type { TriadProvider } from "./ids";
import { loginPage } from "./login";

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

app.get("/", (c) =>
  c.json({
    service: "Triad Auth",
    implementation: "better-auth",
    issuer: c.env.BETTER_AUTH_URL,
    discovery: [
      new URL("/api/auth/.well-known/openid-configuration", c.env.BETTER_AUTH_URL).toString(),
      new URL("/api/auth/.well-known/oauth-authorization-server", c.env.BETTER_AUTH_URL).toString(),
    ],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.get("/login", (c) => {
  const providers = (["google", "github", "twitter"] as TriadProvider[]).filter((provider) =>
    Boolean(c.env[`${provider.toUpperCase()}_CLIENT_ID` as keyof Env]),
  );
  return c.html(loginPage(providers));
});

app.get("/consent", (c) => c.html(consentPage(c.req.query())));

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.onError((error, c) => {
  console.error("request failed", error);
  return c.json({ error: "server_error" }, 500);
});

export default app;
