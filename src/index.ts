import { Hono } from "hono";
import { accountRoutes } from "./routes/account";
import { deviceRoutes } from "./routes/device";
import { oauthRoutes } from "./routes/oauth";
import { securityHeaders } from "./security";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", securityHeaders());
app.route("/", oauthRoutes);
app.route("/", deviceRoutes);
app.route("/", accountRoutes);

app.notFound((c) => {
  const protocolPaths = new Set(["/authorize", "/token", "/device/code", "/device/verify"]);
  const protocolPrefixes = ["/callback/", "/session/", "/api/", "/.well-known/"];
  if (
    protocolPaths.has(c.req.path) ||
    protocolPrefixes.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return c.text("404 Not Found", 404);
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((_error, c) => {
  console.error("request failed");

  return c.json({ error: "server_error" }, 500);
});

export default app;
