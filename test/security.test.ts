import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";
import { cspScriptHashes } from "../src/generated/csp-script-hashes";
import {
  assertSameOrigin,
  consumeCsrfToken,
  createCsrfToken,
  noStore,
  securityHeaders,
} from "../src/security";
import type { Env } from "../src/types";
import { createTestDb } from "./d1";

function cspDirectives(response: Response): Map<string, string> {
  const directives = new Map<string, string>();
  for (const directive of (response.headers.get("content-security-policy") ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) {
      directives.set(name, values.join(" "));
    }
  }
  return directives;
}

async function cspHash(source: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}

describe("browser and response safety", () => {
  it("applies security headers to static assets served through the Worker fallback", async () => {
    let requestedUrl = "";
    const env = {
      ISSUER: "https://auth.example",
      ASSETS: {
        fetch: async (request: Request) => {
          requestedUrl = request.url;
          return new Response("<h1>static page</h1>", {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "text/html",
            },
          });
        },
      } as unknown as Fetcher,
    } as Env;

    const response = await app.request("https://auth.example/demo/", {}, env);

    expect(requestedUrl).toBe("https://auth.example/demo/");
    await expect(response.text()).resolves.toBe("<h1>static page</h1>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("applies security headers when Workers Assets returns immutable headers", async () => {
    const env = {
      ISSUER: "https://auth.example",
      ASSETS: {
        fetch: () => fetch("data:text/html,%3Ch1%3Estatic%20page%3C%2Fh1%3E"),
      } as unknown as Fetcher,
    } as Env;

    const response = await app.request("https://auth.example/demo/", {}, env);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<h1>static page</h1>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("accepts the canonical origin and rejects cross-origin mutation", () => {
    const canonical = new Request("https://auth.example/api", {
      method: "POST",
      headers: { origin: "https://auth.example" },
    });
    const crossOrigin = new Request("https://auth.example/api", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });

    expect(() => assertSameOrigin(canonical, "https://auth.example/issuer")).not.toThrow();
    expect(() => assertSameOrigin(crossOrigin, "https://auth.example")).toThrow("invalid_origin");
    expect(() =>
      assertSameOrigin(new Request("https://auth.example/api"), "https://auth.example"),
    ).toThrow("invalid_origin");
  });

  it("allows only self and generated script hashes without nonces or unsafe-inline", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.text("Triad"));

    const response = await app.request("/");
    const csp = response.headers.get("content-security-policy");
    const directives = cspDirectives(response);

    expect(cspScriptHashes).toEqual(
      [...new Set(cspScriptHashes)].sort((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    );
    expect(directives.get("script-src")).toBe(["'self'", ...cspScriptHashes].join(" "));
    expect(directives.get("style-src")).toBe("'self'");
    expect(csp?.match(/'sha256-[^']+'/g) ?? []).toEqual(cspScriptHashes);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("does not rewrite or authorize arbitrary response markup", async () => {
    const script = "window.untrusted = true";
    const html = `<script>${script}</script><style>body { color: red; }</style>`;
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.html(html));

    const response = await app.request("/");
    const csp = response.headers.get("content-security-policy") ?? "";

    await expect(response.text()).resolves.toBe(html);
    expect(csp).not.toContain(await cspHash(script));
  });

  it("clones a response with no-store cache controls", async () => {
    const original = new Response("secret", { status: 201, headers: { "x-result": "kept" } });
    const response = noStore(original);

    expect(response).not.toBe(original);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-result")).toBe("kept");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.text()).resolves.toBe("secret");
  });

  it("stores only a hash and consumes a purpose-bound CSRF token once", async () => {
    const { db, close } = await createTestDb();
    try {
      const token = await createCsrfToken(db, "consent");
      const stored = await db
        .prepare("SELECT token_hash FROM csrf_tokens WHERE purpose = ?")
        .bind("consent")
        .first<{ token_hash: string }>();

      expect(stored?.token_hash).not.toBe(token);
      await expect(consumeCsrfToken(db, token, "other-purpose")).resolves.toBe(false);
      await expect(consumeCsrfToken(db, token, "consent")).resolves.toBe(true);
      await expect(consumeCsrfToken(db, token, "consent")).resolves.toBe(false);
    } finally {
      close();
    }
  });

  it("rotates one active token per purpose and prunes expired rows during issuance", async () => {
    const { db, close } = await createTestDb();
    const randomValues = crypto.getRandomValues.bind(crypto);
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      if (array.byteLength === 1) {
        (array as Uint8Array).fill(0);
        return array;
      }
      return randomValues(array);
    });
    try {
      const first = await createCsrfToken(db, "consent");
      await db
        .prepare(
          "INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at) VALUES (?, ?, 0, 0)",
        )
        .bind("expired-hash", "expired-purpose")
        .run();
      const second = await createCsrfToken(db, "consent");
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM csrf_tokens")
        .first<{ count: number }>();

      expect(second).not.toBe(first);
      expect(count?.count).toBe(1);
      await expect(consumeCsrfToken(db, first, "consent")).resolves.toBe(false);
      await expect(consumeCsrfToken(db, second, "consent")).resolves.toBe(true);
    } finally {
      random.mockRestore();
      close();
    }
  });
});
