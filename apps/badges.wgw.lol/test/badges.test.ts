import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Fiber, Layer, Logger, Option, References } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, vi } from "vitest";

import { Depot, DepotError, depotLayer } from "../src/depot";
import type { Env } from "../src/env";
import { handle } from "../src/handle";
import worker from "../src/index";
import { socketLayer } from "../src/socket";
import { makeWorker } from "../src/worker";
import { startServer } from "./server";
import type { Reply, Seen } from "./server";

const env: Env = { BADGES_DEPOT_TOKEN: "depot-token", COMMIT_SHA: "abc123" };
const workflow = {
  orgId: "pcnr2v598s",
  repo: "tunnckoCoreHQ/monarch",
  workflowId: "1nk9dzm8gw",
  workflowStatus: "failed",
  jobs: [
    { jobId: "qqd3q5x564", jobKey: "ci.yml:check", status: "finished" },
    { jobId: "kvnf4j3v84", jobKey: "ci.yml:test", status: "failed" },
    { jobId: "6tnh0xnr54", jobKey: "ci.yml:build", status: "skipped" },
    { jobId: "m3z8c0d1p2", jobKey: "ci.yml:lint", status: "cancelled" },
  ],
};

const server = await startServer();
afterAll(server.close);
const depotUrl = `${server.url}/depot.ci.v1.CIService`;

// How Depot and badgen answer when everything works.
function upstream({ path }: Seen): Reply {
  if (path.endsWith("/ListWorkflows")) {
    return {
      json: {
        workflows: [
          { workflowId: "other", workflowPath: ".depot/workflows/publish-ci.yml" },
          { workflowId: "1nk9dzm8gw", workflowPath: ".depot/workflows/ci.yml" },
        ],
      },
    };
  }
  if (path.endsWith("/GetWorkflow")) {
    return { json: workflow };
  }
  if (path.startsWith("/github/checks/")) {
    return { text: "<svg>Socket Security: success</svg>" };
  }
  return { status: 404 };
}

// Answers with `first` the first `times` requests, then like upstream.
function failing(times: number, first: Reply) {
  let count = 0;
  return (request: Seen) => (count++ < times ? first : upstream(request));
}

// Every log line of the worker, as text with its annotations, instead of console output.
const logs: string[] = [];
const capture = Logger.make(({ message, fiber }) => {
  const annotations = fiber.getRef(References.CurrentLogAnnotations);
  logs.push([[message].flat().map(String).join(" "), JSON.stringify(annotations)].join(" "));
});

// The real layers on the real fetch client, pointed at the local server, logging into `logs`.
function layers(depot = depotUrl, badgen = server.url) {
  return Layer.mergeAll(depotLayer(depot), socketLayer(badgen), Logger.layer([capture])).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

// A fresh worker per test, so every test starts with empty caches.
let app = makeWorker(layers());

function get(path: string, bindings: Env = env, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://badges.wgw.lol${path}`, init), bindings);
}

const badge = (path: string) => get(`/tunnckoCoreHQ/monarch${path}`);
const json = async (path: string) => (await badge(path)).json();

// A port that refuses connections: a server that started and stopped.
async function closedUrl(): Promise<string> {
  const closed = await startServer();
  await closed.close();
  return closed.url;
}

beforeEach(() => {
  server.reset();
  logs.length = 0;
  server.reply(upstream);
  app = makeWorker(layers());
});

describe("badges", () => {
  it("shows each job status as badgen JSON", async () => {
    await expect(json("/ci/check.json")).resolves.toEqual({
      subject: "ci: check",
      status: "passing",
      color: "green",
    });
    await expect(json("/ci/test.json")).resolves.toMatchObject({ status: "failing", color: "red" });
    await expect(json("/ci/build.json")).resolves.toMatchObject({
      status: "skipped",
      color: "grey",
    });
    await expect(json("/ci/lint.json")).resolves.toMatchObject({
      status: "cancelled",
      color: "grey",
    });
  });

  it("shows the workflow status", async () => {
    await expect(json("/ci.json")).resolves.toEqual({
      subject: "ci",
      status: "failing",
      color: "red",
    });
  });

  it("asks Depot over Connect for the latest finished push workflow with the worker token", async () => {
    await badge("/ci/test.json");

    expect(server.seen).toEqual([
      {
        method: "POST",
        path: "/depot.ci.v1.CIService/ListWorkflows",
        headers: expect.objectContaining({
          authorization: "Bearer depot-token",
          "connect-protocol-version": "1",
          "content-type": "application/json",
        }),
        body: {
          repo: "tunnckoCoreHQ/monarch",
          name: "ci",
          trigger: "push",
          status: ["finished", "failed"],
          pageSize: 50,
        },
      },
      {
        method: "POST",
        path: "/depot.ci.v1.CIService/GetWorkflow",
        headers: expect.objectContaining({ authorization: "Bearer depot-token" }),
        body: { workflowId: "1nk9dzm8gw" },
      },
    ]);
  });

  it("renders the job badge as SVG with the black label and the Depot logo", async () => {
    const response = await badge("/ci/check.svg");

    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const svg = await response.text();
    expect(svg).toContain("ci: check");
    expect(svg).toContain("passing");
    expect(svg).toContain('fill="#2A2A2A"');
    expect(svg).toContain('xlink:href="data:image/svg+xml;base64,');
  });

  it("answers HEAD like GET", async () => {
    const response = await get("/tunnckoCoreHQ/monarch/ci/check.svg", env, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
  });

  it("shows unknown for a missing job or a missing workflow", async () => {
    await expect(json("/ci/deploy.json")).resolves.toEqual({
      subject: "ci: deploy",
      status: "unknown",
      color: "grey",
    });
    await expect(json("/release/run.json")).resolves.toMatchObject({ status: "unknown" });

    // Depot leaves out an empty workflows list.
    server.reply(() => ({ json: {} }));
    await expect(json("/nightly.json")).resolves.toMatchObject({ status: "unknown" });
  });

  it("shows unknown for a status it does not know", async () => {
    server.reply((request) =>
      request.path.endsWith("/GetWorkflow")
        ? { json: { ...workflow, workflowStatus: "running" } }
        : upstream(request),
    );

    await expect(json("/ci.json")).resolves.toMatchObject({ status: "unknown" });
  });

  it("shows unknown for a Depot error, without retrying a client error", async () => {
    server.reply(() => ({ status: 401, json: { code: "unauthenticated" } }));

    const response = await badge("/ci/test.svg");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("unknown");
    expect(server.seen).toHaveLength(1);
  });

  it("shows unknown when Depot answers a shape the schema rejects", async () => {
    server.reply(() => ({ json: { workflows: [{ workflowId: 1 }] } }));
    await expect(json("/ci/test.json")).resolves.toMatchObject({ status: "unknown" });

    server.reply((request) =>
      request.path.endsWith("/GetWorkflow")
        ? { json: { ...workflow, jobs: "nope" } }
        : upstream(request),
    );
    await expect(json("/ci/build.json")).resolves.toMatchObject({ status: "unknown" });
  });

  it("shows unknown when Depot cannot be reached", async () => {
    app = makeWorker(layers(await closedUrl()));

    await expect(json("/ci/test.json")).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("caching", () => {
  it("asks Depot once for the badges of one workflow", async () => {
    await expect(json("/ci/check.json")).resolves.toMatchObject({ status: "passing" });
    await expect(json("/ci/test.json")).resolves.toMatchObject({ status: "failing" });
    await expect(json("/ci.json")).resolves.toMatchObject({ status: "failing" });
    expect((await badge("/ci/test")).status).toBe(302);

    expect(server.seen.map((request) => request.path)).toEqual([
      "/depot.ci.v1.CIService/ListWorkflows",
      "/depot.ci.v1.CIService/GetWorkflow",
    ]);
  });

  it("shares one Depot lookup between concurrent requests", async () => {
    const results = await Promise.all(
      ["check", "test", "build", "check", "test"].map((job) => json(`/ci/${job}.json`)),
    );
    expect(results).toEqual(
      ["passing", "failing", "skipped", "passing", "failing"].map((status) =>
        expect.objectContaining({ status }),
      ),
    );
    expect(server.seen).toHaveLength(2);
  });

  it("keeps one entry per repository and workflow", async () => {
    await json("/ci/check.json");
    await json("/publish-ci/check.json");
    await get("/tunnckoCoreHQ/other/ci/check.json");

    expect(
      server.seen.filter((request) => request.path.endsWith("/ListWorkflows")).map((r) => r.body),
    ).toEqual([
      expect.objectContaining({ repo: "tunnckoCoreHQ/monarch", name: "ci" }),
      expect.objectContaining({ repo: "tunnckoCoreHQ/monarch", name: "publish-ci" }),
      expect.objectContaining({ repo: "tunnckoCoreHQ/other", name: "ci" }),
    ]);
  });

  it("keeps a failure, so a failing Depot gets one lookup per key and not one per request", async () => {
    server.reply(() => ({ status: 500 }));

    await expect(json("/ci/check.json")).resolves.toMatchObject({ status: "unknown" });
    await expect(json("/ci/test.json")).resolves.toMatchObject({ status: "unknown" });
    expect(server.seen).toHaveLength(3);
  });

  it("keeps a missing workflow, so an unknown badge does not ask again", async () => {
    await json("/release/run.json");
    await json("/release/run.json");

    expect(server.seen).toHaveLength(1);
  });

  it("starts with empty caches in each isolate", async () => {
    await json("/ci/check.json");
    app = makeWorker(layers());
    await json("/ci/check.json");

    expect(server.seen).toHaveLength(4);
  });

  // The Depot service on its own, with the test clock, so the minute passes at once.
  const depot = Layer.mergeAll(
    depotLayer(depotUrl),
    ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
  ).pipe(Layer.provide(FetchHttpClient.layer));

  it.effect("asks Depot again after a minute", () =>
    Effect.gen(function* () {
      const service = yield* Depot;
      const first = yield* service.latestWorkflow("tunnckoCoreHQ/monarch", "ci");
      expect(Option.getOrThrow(first).workflowId).toBe("1nk9dzm8gw");

      yield* TestClock.adjust("59 seconds");
      yield* service.latestWorkflow("tunnckoCoreHQ/monarch", "ci");
      expect(server.seen).toHaveLength(2);

      yield* TestClock.adjust("2 seconds");
      yield* service.latestWorkflow("tunnckoCoreHQ/monarch", "ci");
      expect(server.seen).toHaveLength(4);
    }).pipe(Effect.provide(depot)),
  );

  it.effect("asks Depot again 5 seconds after a failure", () =>
    Effect.gen(function* () {
      server.reply(failing(1, { status: 401 }));
      const service = yield* Depot;
      yield* Effect.flip(service.latestWorkflow("tunnckoCoreHQ/monarch", "ci"));

      yield* TestClock.adjust("4 seconds");
      yield* Effect.flip(service.latestWorkflow("tunnckoCoreHQ/monarch", "ci"));
      expect(server.seen).toHaveLength(1);

      yield* TestClock.adjust("2 seconds");
      const found = yield* service.latestWorkflow("tunnckoCoreHQ/monarch", "ci");
      expect(Option.isSome(found)).toBe(true);
      expect(server.seen).toHaveLength(3);
    }).pipe(Effect.provide(depot)),
  );

  it.effect("gives each attempt 5 seconds, then retries, and fails after the third", () =>
    Effect.gen(function* () {
      server.reply(() => ({ hang: true }));
      const service = yield* Depot;
      const fiber = yield* Effect.forkChild(
        Effect.exit(service.latestWorkflow("tunnckoCoreHQ/monarch", "ci")),
      );

      for (const attempt of [1, 2, 3]) {
        yield* Effect.promise(() => vi.waitFor(() => expect(server.seen).toHaveLength(attempt)));
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("1 second");
      }

      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
      expect(server.seen).toHaveLength(3);
    }).pipe(Effect.provide(depot)),
  );

  it.effect("does not keep an interrupted lookup", () =>
    Effect.gen(function* () {
      server.reply(() => ({ hang: true }));
      const service = yield* Depot;
      const fiber = yield* Effect.forkChild(service.latestWorkflow("tunnckoCoreHQ/monarch", "ci"));
      yield* Effect.promise(() => vi.waitFor(() => expect(server.seen).toHaveLength(1)));
      yield* Fiber.interrupt(fiber);

      server.reply(upstream);
      const found = yield* service.latestWorkflow("tunnckoCoreHQ/monarch", "ci");
      expect(Option.isSome(found)).toBe(true);
      expect(server.seen).toHaveLength(3);
    }).pipe(Effect.provide(depot)),
  );
});

describe("retries", () => {
  it("retries a Depot server error and shows the status", async () => {
    server.reply(failing(2, { status: 503 }));

    await expect(json("/ci/check.json")).resolves.toMatchObject({ status: "passing" });
    expect(server.seen.map((request) => request.path.split("/").at(-1))).toEqual([
      "ListWorkflows",
      "ListWorkflows",
      "ListWorkflows",
      "GetWorkflow",
    ]);
  });

  it("retries each Depot call on its own", async () => {
    server.reply((request) =>
      request.path.endsWith("/GetWorkflow") &&
      server.seen.filter((r) => r.path.endsWith("/GetWorkflow")).length === 1
        ? { status: 429 }
        : upstream(request),
    );

    await expect(json("/ci/check.json")).resolves.toMatchObject({ status: "passing" });
    expect(server.seen).toHaveLength(3);
  });

  it("gives up after two retries and shows unknown", async () => {
    server.reply(() => ({ status: 502 }));

    await expect(json("/ci/check.json")).resolves.toMatchObject({ status: "unknown" });
    expect(server.seen).toHaveLength(3);
  });

  it("retries badgen and shows the Socket badge", async () => {
    server.reply(failing(1, { status: 500 }));

    expect(await (await badge("/socket")).text()).toBe("<svg>Socket Security: passing</svg>");
    expect(server.seen).toHaveLength(2);
  });
});

describe("socket", () => {
  it("proxies the badgen Socket checks badge with passing and failing", async () => {
    const response = await badge("/socket");

    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.text()).toBe("<svg>Socket Security: passing</svg>");
    expect(server.seen).toEqual([
      {
        method: "GET",
        path: "/github/checks/tunnckoCoreHQ/monarch/master/Socket%20Security:%20Project%20Report?label=Socket%20Security&labelColor=black&icon=socket",
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
        body: undefined,
      },
    ]);

    server.reply(() => ({ text: "<svg>Socket Security: failure</svg>" }));
    expect(await (await get("/tunnckoCoreHQ/other/socket")).text()).toBe(
      "<svg>Socket Security: failing</svg>",
    );
  });

  it("keeps the Socket badge for a minute", async () => {
    await badge("/socket");
    await badge("/socket");

    expect(server.seen).toHaveLength(1);
  });

  it("shows unknown when badgen answers an error", async () => {
    server.reply(() => ({ status: 404 }));

    const response = await badge("/socket");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("Socket Security: unknown");
    expect(server.seen).toHaveLength(1);
  });

  it("shows unknown when badgen cannot be reached", async () => {
    app = makeWorker(layers(depotUrl, await closedUrl()));

    expect(await (await badge("/socket")).text()).toContain("Socket Security: unknown");
  });
});

describe("health", () => {
  it("shows the deployed commit without asking Depot", async () => {
    await expect((await get("/health")).json()).resolves.toEqual({
      ok: true,
      link: "https://github.com/tunnckoCoreHQ/monarch/commit/abc123",
      commit: "abc123",
    });
    expect(server.seen).toHaveLength(0);
  });

  it("links the repository for a local deploy", async () => {
    await expect((await get("/health", { ...env, COMMIT_SHA: "local" })).json()).resolves.toEqual({
      ok: true,
      link: "https://github.com/tunnckoCoreHQ/monarch",
      commit: "local",
    });
  });
});

describe("links", () => {
  it("redirects a job to that job in the latest finished run", async () => {
    const response = await badge("/ci/test");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://depot.dev/orgs/pcnr2v598s/workflows/1nk9dzm8gw?job=kvnf4j3v84&repo=tunnckoCoreHQ%2Fmonarch",
    );
  });

  it("redirects a workflow to the Depot CI product page without asking Depot", async () => {
    const response = await badge("/ci");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://depot.dev/products/ci");
    expect(server.seen).toHaveLength(0);
  });

  it("answers 404 for a missing job or workflow", async () => {
    expect((await badge("/ci/deploy")).status).toBe(404);
    expect((await badge("/release/run")).status).toBe(404);
  });

  it("answers 502 for a Depot error, a rejected shape, or an unreachable Depot", async () => {
    server.reply(() => ({ status: 500 }));
    expect((await badge("/ci/test")).status).toBe(502);

    server.reply(() => ({ json: { workflows: [{ workflowId: 1 }] } }));
    expect((await badge("/ci/test")).status).toBe(502);

    app = makeWorker(layers(await closedUrl()));
    expect((await badge("/ci/test")).status).toBe(502);
  });
});

describe("routing", () => {
  it("answers 404 for other paths", async () => {
    expect((await get("")).status).toBe(404);
    expect((await get("/tunnckoCoreHQ/monarch")).status).toBe(404);
    expect((await get("/tunnckoCoreHQ/monarch/ci/test/extra")).status).toBe(404);
    expect((await get("/a/b/c%20d.svg")).status).toBe(404);
    expect(server.seen).toHaveLength(0);
  });

  it("answers 405 for methods other than GET and HEAD", async () => {
    const response = await get("/tunnckoCoreHQ/monarch/ci/test.svg", env, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves the routes that skip Depot without the Depot token", async () => {
    const noToken: Env = { ...env };
    Reflect.deleteProperty(noToken, "BADGES_DEPOT_TOKEN");

    expect((await get("/health", noToken)).status).toBe(200);
    expect((await get("/tunnckoCoreHQ/monarch/ci", noToken)).status).toBe(302);
    expect((await get("/a/b", noToken)).status).toBe(404);
    expect(await (await get("/tunnckoCoreHQ/monarch/socket", noToken)).text()).toContain("passing");
    await expect(
      (await get("/tunnckoCoreHQ/monarch/ci/test.json", noToken)).json(),
    ).resolves.toMatchObject({ status: "unknown" });
    expect((await get("/tunnckoCoreHQ/monarch/ci/test", noToken)).status).toBe(502);
    expect(server.seen.every((request) => request.path.startsWith("/github/"))).toBe(true);
  });

  it("serves the deployed worker on the live layers", async () => {
    await expect(
      (await worker.fetch(new Request("https://badges.wgw.lol/health"), env)).json(),
    ).resolves.toMatchObject({ commit: "abc123" });
  });

  it("answers 502 for a thrown error, like the worker before Effect", async () => {
    const broken = {
      ...env,
      get COMMIT_SHA(): string {
        throw new Error("boom");
      },
    };

    expect((await get("/health", broken)).status).toBe(502);
    expect(logs).toEqual([expect.stringContaining("Request failed Error: boom")]);
  });
});

describe("logs", () => {
  it("names the Depot call, its cause, and the path", async () => {
    server.reply(() => ({ status: 401 }));
    await json("/ci/check.json");

    expect(logs).toEqual([
      expect.stringMatching(
        /^Depot ListWorkflows failed .*401.*"path":"\/tunnckoCoreHQ\/monarch\/ci\/check.json"/,
      ),
    ]);
  });

  it("names a missing token", async () => {
    const noToken: Env = { ...env };
    Reflect.deleteProperty(noToken, "BADGES_DEPOT_TOKEN");
    await get("/tunnckoCoreHQ/monarch/ci/test.json", noToken);

    expect(logs).toEqual([
      expect.stringMatching(/^Depot ListWorkflows failed .*BADGES_DEPOT_TOKEN/s),
    ]);
  });

  it("names the badgen cause of the Socket badge", async () => {
    server.reply(() => ({ status: 404 }));
    await badge("/socket");

    expect(logs).toEqual([expect.stringMatching(/^Socket badge failed .*404/)]);
  });

  it("logs a failed job redirect once", async () => {
    server.reply(() => ({ status: 401 }));
    expect((await badge("/ci/test")).status).toBe(502);

    expect(logs).toEqual([expect.stringMatching(/^Depot ListWorkflows failed .*401/)]);
  });
});

describe("handle", () => {
  // Any Depot can be provided, for example one that always fails.
  const brokenDepot = Layer.succeed(
    Depot,
    Depot.of({
      latestWorkflow: (_repo, _workflow) =>
        Effect.fail(new DepotError({ method: "ListWorkflows", cause: "down" })),
    }),
  );

  it.effect("fails the job redirect with the Depot error", () =>
    Effect.gen(function* () {
      const error = yield* handle(
        new Request("https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/test"),
        env,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(DepotError);
      expect(error.method).toBe("ListWorkflows");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          brokenDepot,
          socketLayer(server.url).pipe(Layer.provide(FetchHttpClient.layer)),
          Logger.layer([]),
        ),
      ),
    ),
  );
});
