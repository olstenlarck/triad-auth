import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import { randomToken, sha256 } from "./crypto";

const csrfLifetimeSeconds = 10 * 60;

export function securityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    const nonce = randomToken(16);
    const headers = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", `'nonce-${nonce}'`],
        styleSrc: ["'self'", `'nonce-${nonce}'`],
      },
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
      },
    });

    await headers(context, next);
    if (context.res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
      context.res = new HTMLRewriter()
        .on("script", {
          element(element) {
            if (!element.hasAttribute("src")) element.setAttribute("nonce", nonce);
          },
        })
        .on("style", {
          element(element) {
            element.setAttribute("nonce", nonce);
          },
        })
        .transform(context.res);
    }
  };
}

export function assertSameOrigin(request: Request, issuer: string): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(issuer).origin) throw new Error("invalid_origin");
}

export async function createCsrfToken(db: D1Database, purpose: string): Promise<string> {
  const token = randomToken();
  const createdAt = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), purpose, createdAt + csrfLifetimeSeconds, createdAt)
    .run();
  return token;
}

export async function consumeCsrfToken(db: D1Database, token: string, purpose: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare("DELETE FROM csrf_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?")
    .bind(await sha256(token), purpose, now)
    .run();
  return result.meta.changes === 1;
}

export function noStore(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("cache-control", "no-store");
  next.headers.set("pragma", "no-cache");
  return next;
}
