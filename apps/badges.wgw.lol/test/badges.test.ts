import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import worker from "../src/index";

const env: Env = { DEPOT_TOKEN: "depot-token" };
const base = "https://badges.wgw.lol/tunnckoCoreHQ/monarch";
const workflow = {
  orgId: "pcnr2v598s",
  repo: "tunnckoCoreHQ/monarch",
  workflowId: "1nk9dzm8gw",
  workflowStatus: "failed",
  jobs: [
    { jobId: "qqd3q5x564", jobKey: "ci.yml:check", status: "finished" },
    { jobId: "kvnf4j3v84", jobKey: "ci.yml:test", status: "failed" },
    { jobId: "6tnh0xnr54", jobKey: "ci.yml:build", status: "skipped" },
  ],
};
const depot = vi.fn();

function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`${base}${path}`), env);
}

beforeEach(() => {
  depot.mockReset();
  depot.mockImplementation((method: string) =>
    method === "ListWorkflows"
      ? Response.json({
          workflows: [
            { workflowId: "other", workflowPath: "publish-ci.yml" },
            { workflowId: "1nk9dzm8gw", workflowPath: "ci.yml" },
          ],
        })
      : Response.json(workflow),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      depot(String(input).split("/").at(-1), JSON.parse(String(init?.body)), init?.headers),
    ),
  );
});

describe("badges", () => {
  it("shows each job status as badgen JSON", async () => {
    await expect((await get("/ci/check.json")).json()).resolves.toEqual({
      subject: "ci: check",
      status: "passing",
      color: "green",
    });
    await expect((await get("/ci/test.json")).json()).resolves.toMatchObject({
      status: "failing",
      color: "red",
    });
    await expect((await get("/ci/build.json")).json()).resolves.toMatchObject({
      status: "skipped",
      color: "grey",
    });
  });

  it("asks Depot for the latest finished push workflow with the worker token", async () => {
    await get("/ci/test.json");

    expect(depot).toHaveBeenNthCalledWith(
      1,
      "ListWorkflows",
      {
        repo: "tunnckoCoreHQ/monarch",
        name: "ci",
        trigger: "push",
        status: ["finished", "failed"],
        pageSize: 50,
      },
      expect.objectContaining({ authorization: "Bearer depot-token" }),
    );
    expect(depot).toHaveBeenNthCalledWith(
      2,
      "GetWorkflow",
      { workflowId: "1nk9dzm8gw" },
      expect.anything(),
    );
  });

  it("renders the job badge as SVG", async () => {
    const response = await get("/ci/check.svg");

    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const svg = await response.text();
    expect(svg).toContain("ci: check");
    expect(svg).toContain("passing");
  });

  it("shows the workflow status", async () => {
    await expect((await get("/ci.json")).json()).resolves.toEqual({
      subject: "ci",
      status: "failing",
      color: "red",
    });
  });

  it("shows unknown for a missing job, a missing workflow, or a Depot error", async () => {
    await expect((await get("/ci/lint.json")).json()).resolves.toMatchObject({ status: "unknown" });
    await expect((await get("/deploy/run.json")).json()).resolves.toMatchObject({
      status: "unknown",
    });

    depot.mockResolvedValue(new Response("nope", { status: 401 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await get("/ci/test.svg");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("unknown");
  });
});

describe("links", () => {
  it("redirects a job to that job in the latest finished run", async () => {
    const response = await get("/ci/test");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://depot.dev/orgs/pcnr2v598s/workflows/1nk9dzm8gw?job=kvnf4j3v84&repo=tunnckoCoreHQ%2Fmonarch",
    );
  });

  it("redirects a workflow to the Depot CI product page without asking Depot", async () => {
    const response = await get("/ci");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://depot.dev/products/ci");
    expect(depot).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing job and 502 for a Depot error", async () => {
    expect((await get("/ci/lint")).status).toBe(404);

    depot.mockResolvedValue(new Response("nope", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await get("/ci/test")).status).toBe(502);
  });

  it("answers 404 for other paths", async () => {
    expect((await get("")).status).toBe(404);
    expect((await get("/ci/test/extra")).status).toBe(404);
    expect(
      (await worker.fetch(new Request("https://badges.wgw.lol/a/b/c%20d.svg"), env)).status,
    ).toBe(404);
  });
});
