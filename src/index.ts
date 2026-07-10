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

app.onError((_error, c) => {
  console.error("request failed");
  return c.json({ error: "server_error" }, 500);
});

export default app;
