import { afterEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { env, network, registry } from "./utils";

let app: ReturnType<typeof registry> | undefined;

function start(respond: Parameters<typeof network>[0]) {
  const net = network(respond);
  app = registry(net.fetch);
  return { app, calls: net.calls };
}

afterEach(() => app?.dispose());

const packument = {
  name: "@tunnckocore/calc",
  versions: {
    "1.0.0": { dist: { tarball: `${env.VLT_UPSTREAM_URL}@tunnckocore/calc/-/calc-1.0.0.tgz` } },
  },
};

function upstreamJson(body: unknown) {
  return Response.json(body, { headers: { etag: '"v1"', "content-length": "999" } });
}

describe("health", () => {
  it("reports the deployed commit", async () => {
    const { app } = start(() => new Response(null, { status: 500 }));
    const response = await app.request("https://npm.wgw.lol/-/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      link: "https://github.com/tunnckoCoreHQ/monarch",
      commit: "local",
    });
  });
});

describe("reads", () => {
  it("rewrites VLT tarball URLs in a packument to this registry", async () => {
    const { app, calls } = start(() => upstreamJson(packument));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({
      name: "@tunnckocore/calc",
      versions: {
        "1.0.0": {
          dist: { tarball: "https://npm.wgw.lol/@tunnckocore/calc/-/calc-1.0.0.tgz" },
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${env.VLT_UPSTREAM_URL}@tunnckocore%2fcalc`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer read-service-token");
  });

  it("keeps the query string", async () => {
    const { app, calls } = start(() => upstreamJson(packument));
    await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc?write=true");

    expect(calls[0].url).toBe(`${env.VLT_UPSTREAM_URL}@tunnckocore%2fcalc?write=true`);
  });

  it("answers HEAD without a body and keeps the upstream etag", async () => {
    const { app, calls } = start(() => upstreamJson(packument));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc", {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(await response.text()).toBe("");
    expect(calls[0].method).toBe("HEAD");
  });

  it("caches tarballs at the edge and in clients for a year", async () => {
    const { app, calls } = start(
      () => new Response("tarball", { headers: { "content-type": "application/octet-stream" } }),
    );
    const response = await app.request("https://npm.wgw.lol/@tunnckocore/calc/-/calc-1.0.0.tgz");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("tarball");
    expect(calls[0].cf).toEqual({ cacheEverything: true, cacheTtl: 31_536_000 });
  });

  it("passes non-JSON bodies through unchanged", async () => {
    const { app } = start(() => new Response(env.VLT_UPSTREAM_URL));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc");

    expect(await response.text()).toBe(env.VLT_UPSTREAM_URL);
  });

  it("double-encodes the package name of dist-tag paths for VLT", async () => {
    const { app, calls } = start(() => upstreamJson({ latest: "1.0.0" }));
    const response = await app.request(
      "https://npm.wgw.lol/-/package/@tunnckocore%2fcalc/dist-tags",
    );

    expect(await response.json()).toEqual({ latest: "1.0.0" });
    expect(calls[0].url).toBe(`${env.VLT_UPSTREAM_URL}-/package/@tunnckocore%252Fcalc/dist-tags`);
  });

  it("returns upstream errors as they are", async () => {
    const { app } = start(() => Response.json({ error: "missing" }, { status: 404 }));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fmissing");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(await response.json()).toEqual({ error: "missing" });
  });

  it("answers 502 when VLT is unreachable", async () => {
    const { app } = start(() => {
      throw new TypeError("fetch failed");
    });
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Bad gateway" });
  });
});

describe("routing", () => {
  it.each([
    "/calc",
    "/@other%2fcalc",
    "/@tunnckocore%2f..%2fcalc",
    "/@tunnckocore/calc/../../other",
    "/-/package/@other%2fcalc/dist-tags",
    "/%E0%A4%A",
  ])("knows only @tunnckocore packages: %s", async (path) => {
    const { app, calls } = start(() => new Response("{}"));
    const response = await app.request(`https://npm.wgw.lol${path}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(calls).toHaveLength(0);
  });

  it("rejects other methods", async () => {
    const { app, calls } = start(() => new Response("{}"));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc", {
      method: "PATCH",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PUT, POST, DELETE");
    expect(await response.json()).toEqual({ error: "Method not allowed" });
    expect(calls).toHaveLength(0);
  });

  it("asks for a bearer token on writes", async () => {
    const { app } = start(() => new Response("{}"));
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc", {
      method: "PUT",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="npm.wgw.lol"');
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("does not route an exchange for a package name that does not decode", async () => {
    const { app } = start(() => new Response("{}"));
    const response = await app.request(
      "https://npm.wgw.lol/-/npm/v1/oidc/token/exchange/package/%E0%A4%A",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("worker", () => {
  it("serves requests with the bindings it receives", async () => {
    const response = await worker.fetch(new Request("https://npm.wgw.lol/-/health"), {
      ...env,
      COMMIT_SHA: "abc123",
    });

    expect(await response.json()).toEqual({
      ok: true,
      link: "https://github.com/tunnckoCoreHQ/monarch/commit/abc123",
      commit: "abc123",
    });
  });
});
