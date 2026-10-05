import { badgen } from "badgen";

import type { Env } from "./env";

const DEPOT_API = "https://api.depot.dev/depot.ci.v1.CIService";
const DEPOT_CI_PRODUCT = "https://depot.dev/products/ci";
const SEGMENT = /^[\w.-]+$/;
const GITHUB_API = "https://api.github.com/repos";
const SOCKET_CHECK = "Socket Security: Project Report";
// The simple-icons 16.34.0 Socket logo, filled white.
const SOCKET_ICON =
  "data:image/svg+xml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgdmlld0JveD0iMCAwIDI0IDI0IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxwYXRoIGQ9Ik0yLjkzIDExLjE3MWMwIDUuOTIgMy43NzggMTAuOTU3IDkuMDYzIDEyLjgyOWExMy42NTIgMTMuNjUyIDAgMCAwIDYuNTEzLTQuODkgMTMuNDk3IDEzLjQ5NyAwIDAgMCAyLjU2NC03LjkzOVYzLjI3NEwxMS45OTcgMCAyLjkzMyAzLjI3NHY3Ljg5N3ptNy40OTEtNi4wOWg0LjIwOEwxMy4zNCA5LjQ3aDIuMjkybC02LjI2NCA5LjQ0NiAxLjQ4Ni02Ljg1OEg4LjM2NXoiLz48L3N2Zz4=";

interface Badge {
  subject: string;
  status: string;
  color: string;
}

interface ListWorkflowsRequest {
  repo: string;
  name: string;
  trigger: string;
  status: string[];
  pageSize: number;
}

interface GetWorkflowRequest {
  workflowId: string;
}

interface ListWorkflowsResponse {
  workflows?: Array<{ workflowId: string; workflowPath: string }>;
}

interface GetWorkflowResponse {
  orgId: string;
  repo: string;
  workflowId: string;
  workflowStatus: string;
  jobs?: Array<{ jobId: string; jobKey: string; status: string }>;
}

interface CheckRunsResponse {
  check_runs?: Array<{ conclusion: string | null }>;
}

const STATUS: Record<string, Pick<Badge, "status" | "color">> = {
  finished: { status: "passing", color: "green" },
  failed: { status: "failing", color: "red" },
  cancelled: { status: "cancelled", color: "grey" },
  skipped: { status: "skipped", color: "grey" },
};

// GitHub check run conclusions in the Depot terms of STATUS.
const CONCLUSION: Record<string, string> = {
  success: "finished",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

async function depot<T>(
  env: Env,
  method: string,
  body: ListWorkflowsRequest | GetWorkflowRequest,
): Promise<T> {
  const response = await fetch(`${DEPOT_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BADGES_DEPOT_TOKEN}`,
      "connect-protocol-version": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Depot ${method} answered ${response.status}`);
  }
  // SAFETY: the Depot CI API answers this method with this shape, checked by response.ok above.
  return response.json();
}

// The newest finished or failed workflow from a master push. In this repository only master
// pushes have the push trigger, and skipping running workflows keeps the badge from flickering.
async function latestWorkflow(
  env: Env,
  repo: string,
  workflow: string,
): Promise<GetWorkflowResponse | undefined> {
  const { workflows = [] } = await depot<ListWorkflowsResponse>(env, "ListWorkflows", {
    repo,
    name: workflow,
    trigger: "push",
    status: ["finished", "failed"],
    pageSize: 50,
  });
  const file = new RegExp(`(?:^|/)${workflow.replaceAll(".", "\\.")}\\.ya?ml$`);
  const found = workflows.find((item) => file.test(item.workflowPath));
  if (!found) {
    return undefined;
  }
  return depot<GetWorkflowResponse>(env, "GetWorkflow", { workflowId: found.workflowId });
}

// The conclusion of the Socket check run on the default branch head. GitHub allows 60
// unauthenticated requests an hour, so Cloudflare caches the answer for five minutes.
async function socketConclusion(repo: string): Promise<string | undefined> {
  const url = new URL(`${GITHUB_API}/${repo}/commits/HEAD/check-runs`);
  url.searchParams.set("check_name", SOCKET_CHECK);
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "badges.wgw.lol" },
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!response.ok) {
    throw new Error(`GitHub check-runs answered ${response.status}`);
  }
  // SAFETY: GitHub answers check-runs with this shape, checked by response.ok above.
  const { check_runs: runs = [] }: CheckRunsResponse = await response.json();
  return runs[0]?.conclusion ?? undefined;
}

async function socket(repo: string, format: string): Promise<Response> {
  let conclusion: string | undefined;
  try {
    conclusion = await socketConclusion(repo);
  } catch (error) {
    console.error(error);
  }
  const known = conclusion ? STATUS[CONCLUSION[conclusion] ?? ""] : undefined;
  const badge: Badge = { subject: "Socket Security", status: "unknown", color: "grey", ...known };
  return render(badge, format, SOCKET_ICON);
}

function render(badge: Badge, format: string, icon?: string): Response {
  const headers = { "cache-control": "public, max-age=60" };
  if (format === "json") {
    return Response.json(badge, { headers });
  }
  return new Response(badgen({ ...badge, labelColor: "black", icon }), {
    headers: { ...headers, "content-type": "image/svg+xml; charset=utf-8" },
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const match = /^(.+?)(?:\.(svg|json))?$/.exec(new URL(request.url).pathname.slice(1));
  const segments = match?.[1]?.split("/") ?? [];
  const format = match?.[2];
  const [owner = "", name = "", workflow = "", job] = segments;
  if (segments.length < 3 || segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) {
    return new Response("Not Found", { status: 404 });
  }
  // The Socket badge has no link to redirect to.
  if (owner === "socket" && !job) {
    return format
      ? socket(segments.slice(1).join("/"), format)
      : new Response("Not Found", { status: 404 });
  }
  if (!format && !job) {
    return Response.redirect(DEPOT_CI_PRODUCT, 302);
  }

  const subject = job ? `${workflow}: ${job}` : workflow;
  const unknown: Badge = { subject, status: "unknown", color: "grey" };
  let found: GetWorkflowResponse | undefined;
  try {
    found = await latestWorkflow(env, `${owner}/${name}`, workflow);
  } catch (error) {
    // A broken image helps nobody, so badges show "unknown"; the redirect answers 502.
    if (!format) {
      throw error;
    }
    console.error(error);
  }
  const foundJob = found?.jobs?.find((item) => item.jobKey.split(":").at(-1) === job);

  if (!format) {
    if (!found || !foundJob) {
      return new Response("Not Found", { status: 404 });
    }
    const link = new URL(`https://depot.dev/orgs/${found.orgId}/workflows/${found.workflowId}`);
    link.searchParams.set("job", foundJob.jobId);
    link.searchParams.set("repo", found.repo);
    return Response.redirect(link.href, 302);
  }

  const status = job ? foundJob?.status : found?.workflowStatus;
  const known = status ? STATUS[status] : undefined;
  return render(known ? { subject, ...known } : unknown, format);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(error);
      return new Response("Bad Gateway", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
