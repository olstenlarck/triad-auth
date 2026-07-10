import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSameOrigin, consumeCsrfToken, createCsrfToken, noStore, securityHeaders } from "../src/security";

interface StoredCsrfToken {
  purpose: string;
  expiresAt: number;
}

const insertCsrfToken = "INSERT INTO csrf_tokens (token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?)";
const consumeCsrfTokenOnce = "DELETE FROM csrf_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?";

class FakeD1 {
  readonly tokens = new Map<string, StoredCsrfToken>();

  prepare(query: string): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => {
        if (query === insertCsrfToken) {
          return {
            run: async () => {
              const [tokenHash, purpose, expiresAt] = values as [string, string, number, number];
              this.tokens.set(tokenHash, { purpose, expiresAt });
              return { meta: { changes: 1 } } as D1Result;
            },
          } as D1PreparedStatement;
        }

        if (query === consumeCsrfTokenOnce) {
          return {
            run: async () => {
              const [tokenHash, purpose, now] = values as [string, string, number];
              const token = this.tokens.get(tokenHash);
              const consumed = token?.purpose === purpose && token.expiresAt > now;
              if (consumed) this.tokens.delete(tokenHash);
              return { meta: { changes: consumed ? 1 : 0 } } as D1Result;
            },
          } as D1PreparedStatement;
        }

        throw new Error(`Unexpected query: ${query}`);
      },
    } as D1PreparedStatement;
  }
}

class TestHTMLRewriter {
  private readonly handlers = new Map<string, HTMLRewriterElementContentHandlers>();

  on(selector: string, handlers: HTMLRewriterElementContentHandlers): TestHTMLRewriter {
    this.handlers.set(selector, handlers);
    return this;
  }

  transform(response: Response): Response {
    const handlers = this.handlers;
    const body = new ReadableStream({
      async start(controller) {
        let html = await response.text();
        for (const tagName of ["script", "style"]) {
          const handler = handlers.get(tagName);
          if (!handler?.element) continue;
          html = html.replace(new RegExp(`<${tagName}([^>]*)>`, "gi"), (_tag, rawAttributes: string) => {
            let attributes = rawAttributes;
            const element = {
              hasAttribute(name: string) {
                return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(attributes);
              },
              setAttribute(name: string, value: string) {
                attributes += ` ${name}="${value}"`;
                return this;
              },
            } as unknown as Element;
            handler.element?.(element);
            return `<${tagName}${attributes}>`;
          });
        }
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
}

function extractNonce(response: Response): string {
  const csp = response.headers.get("content-security-policy") ?? "";
  const match = csp.match(/script-src 'self' 'nonce-([^']+)'/);
  expect(match).not.toBeNull();
  const nonce = match?.[1] ?? "";
  expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
  return nonce;
}

afterEach(() => vi.unstubAllGlobals());

describe("browser and response safety", () => {
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
    expect(() => assertSameOrigin(new Request("https://auth.example/api"), "https://auth.example")).toThrow("invalid_origin");
  });

  it("sets restrictive browser security headers with a nonce and no unsafe-inline", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.text("Triad"));

    const response = await app.request("/");
    const csp = response.headers.get("content-security-policy");

    extractNonce(response);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("uses a fresh nonce for every response", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.text("Triad"));

    const first = extractNonce(await app.request("/"));
    const second = extractNonce(await app.request("/"));

    expect(first).not.toBe(second);
  });

  it("injects the response nonce into inline script and style elements", async () => {
    vi.stubGlobal("HTMLRewriter", TestHTMLRewriter);
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", () => new Response(
      '<script>window.ready = true</script><script src="/app.js"></script><style>body { color: black; }</style>',
      { headers: { "content-type": "text/html; charset=UTF-8", "x-route": "kept" } },
    ));

    const response = await app.request("/");
    const nonce = extractNonce(response);
    const html = await response.text();

    expect(html).toContain(`<script nonce="${nonce}">window.ready = true</script>`);
    expect(html).toContain('<script src="/app.js"></script>');
    expect(html).toContain(`<style nonce="${nonce}">body { color: black; }</style>`);
    expect(response.headers.get("x-route")).toBe("kept");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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
    const fake = new FakeD1();
    const db = fake as unknown as D1Database;
    const token = await createCsrfToken(db, "consent");

    expect(fake.tokens.has(token)).toBe(false);
    await expect(consumeCsrfToken(db, token, "other-purpose")).resolves.toBe(false);
    await expect(consumeCsrfToken(db, token, "consent")).resolves.toBe(true);
    await expect(consumeCsrfToken(db, token, "consent")).resolves.toBe(false);
  });

  it("does not consume an expired CSRF token", async () => {
    const fake = new FakeD1();
    const db = fake as unknown as D1Database;
    const token = await createCsrfToken(db, "device");
    const stored = [...fake.tokens.values()][0];
    stored.expiresAt = 0;

    await expect(consumeCsrfToken(db, token, "device")).resolves.toBe(false);
  });
});
