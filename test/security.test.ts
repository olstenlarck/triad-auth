import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cspScriptHashes } from "../src/generated/csp-script-hashes";
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

function cspDirectives(response: Response): Map<string, string> {
  const directives = new Map<string, string>();
  for (const directive of (response.headers.get("content-security-policy") ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) directives.set(name, values.join(" "));
  }
  return directives;
}

async function cspHash(source: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}

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

  it("allows only self and generated script hashes without nonces or unsafe-inline", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.text("Triad"));

    const response = await app.request("/");
    const csp = response.headers.get("content-security-policy");
    const directives = cspDirectives(response);

    expect(cspScriptHashes.length).toBeGreaterThan(0);
    expect(cspScriptHashes).toEqual([...new Set(cspScriptHashes)].sort());
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
    expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
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
