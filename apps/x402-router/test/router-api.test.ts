import { describe, expect, it } from "vitest";

// The deployed Worker.
const origin = "https://x402-router.wgw.lol";

describe("x402-router", () => {
  it.each(["/health", "/healthz", "/health/", "/healthz/"])(
    "answers GET %s with the build commit",
    async (path) => {
      const response = await fetch(`${origin}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        ok: true,
        service: "@tunnckocore/x402-router",
        commit: expect.any(String),
      });
    },
  );

  it("lists the supported payment kinds", async () => {
    const response = await fetch(`${origin}/supported`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { kinds: { network: string }[]; extensions: string[] };
    expect(body.kinds.map((kind) => kind.network)).toContain("eip155:1");
    expect(body.extensions.length).toBeGreaterThan(0);
  });

  it("answers unknown paths with a JSON 404", async () => {
    const response = await fetch(`${origin}/nope`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("answers CORS preflight on the API", async () => {
    const response = await fetch(`${origin}/health`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("serves the Markdown docs and llms.txt as static files", async () => {
    const docs = await fetch(`${origin}/docs/upstreams.md`);
    const llms = await fetch(`${origin}/llms.txt`);

    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/markdown");
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
  });
});
