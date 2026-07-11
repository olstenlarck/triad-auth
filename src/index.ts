import { Hono } from "hono";
import { accountRoutes } from "./routes/account";
import { deviceRoutes } from "./routes/device";
import { oauthRoutes } from "./routes/oauth";
import { securityHeaders } from "./security";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();
const protocolPaths = new Set(["/authorize", "/token", "/device/code", "/device/verify"]);
const protocolPrefixes = ["/callback/", "/session/", "/account/", "/api/", "/.well-known/"];
const browserPagePaths = new Set([
  "/",
  "/consent/",
  "/demo/",
  "/demo/callback/",
  "/device/verify/",
  "/me/",
]);

app.use("*", securityHeaders());
app.use("*", async (c, next) => {
  const requestUrl = new URL(c.req.url);
  const issuer = new URL(c.env.ISSUER);
  const localRequest = requestUrl.hostname === "localhost";

  if (
    c.req.method === "GET" &&
    !localRequest &&
    requestUrl.origin !== issuer.origin &&
    browserPagePaths.has(c.req.path)
  ) {
    return c.redirect(
      new URL(`${requestUrl.pathname}${requestUrl.search}`, issuer).toString(),
      308,
    );
  }

  await next();
});
app.use("*", async (c, next) => {
  await next();

  if (
    protocolPaths.has(c.req.path) ||
    c.req.path.startsWith("/device/") ||
    protocolPrefixes.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
  }
});
app.route("/", oauthRoutes);
app.route("/", deviceRoutes);
app.route("/", accountRoutes);

app.notFound(async (c) => {
  if (
    protocolPaths.has(c.req.path) ||
    protocolPrefixes.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return c.text("404 Not Found", 404);
  }

  if (c.req.path.startsWith("/__astro_")) {
    const { handle } = await import("@astrojs/cloudflare/handler");

    return handle(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  }

  const asset = await c.env.ASSETS.fetch(c.req.raw);

  return new Response(asset.body, asset);
});

app.onError((_error, c) => {
  console.error("request failed");

  return c.json({ error: "server_error" }, 500);
});

export default app;
