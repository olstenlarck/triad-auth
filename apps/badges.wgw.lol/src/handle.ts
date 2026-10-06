import { Effect, Option } from "effect";

import { Depot } from "./depot";
import type { DepotError, Workflow } from "./depot";
import type { Env } from "./env";
import { UNKNOWN, depotBadge, health, render, svg } from "./render";
import { Socket } from "./socket";
import type { BadgenError } from "./socket";

const DEPOT_CI_PRODUCT = "https://depot.dev/products/ci";
const SEGMENT = /^[\w.-]+$/;

// The default logger prints an error as its tag only, so the log names the call and its cause.
export const logFailure = (error: DepotError | BadgenError) =>
  Effect.logError(
    error._tag === "Depot.DepotError" ? `Depot ${error.method} failed` : "Socket badge failed",
    String(error.cause),
  );

const jobOf = (workflow: Workflow, job: string | undefined) =>
  workflow.jobs?.find((item) => item.jobKey.split(":").at(-1) === job);

export const handle = Effect.fn("Badges.handle")(function* (request: Request, env: Env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const { pathname } = new URL(request.url);
  // Badge paths have at least three segments, so this cannot shadow a badge.
  if (pathname === "/health") {
    return health(env.COMMIT_SHA);
  }
  const match = /^(.+?)(?:\.(svg|json))?$/.exec(pathname.slice(1));
  const segments = match?.[1]?.split("/") ?? [];
  const format = match?.[2];
  const [owner = "", name = "", workflow = "", job] = segments;
  if (segments.length < 3 || segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) {
    return new Response("Not Found", { status: 404 });
  }
  if (workflow === "socket" && !job) {
    const socket = yield* Socket;
    // A broken image helps nobody, so the badge shows "unknown" like the Depot badges.
    return yield* socket.badge(`${owner}/${name}`).pipe(
      Effect.map(svg),
      Effect.tapError(logFailure),
      Effect.orElseSucceed(() => render({ subject: "Socket Security", ...UNKNOWN }, "svg")),
    );
  }
  if (!format && !job) {
    return Response.redirect(DEPOT_CI_PRODUCT, 302);
  }

  const depot = yield* Depot;

  if (!format) {
    // The redirect has no truthful fallback, so a Depot error stays a failure and answers 502.
    const found = yield* depot.latestWorkflow(`${owner}/${name}`, workflow);
    const foundJob = Option.isSome(found) ? jobOf(found.value, job) : undefined;
    if (Option.isNone(found) || !foundJob) {
      return new Response("Not Found", { status: 404 });
    }
    const link = new URL(
      `https://depot.dev/orgs/${found.value.orgId}/workflows/${found.value.workflowId}`,
    );
    link.searchParams.set("job", foundJob.jobId);
    link.searchParams.set("repo", found.value.repo);
    return Response.redirect(link.href, 302);
  }

  // A broken image helps nobody, so badges show "unknown" on a Depot error.
  const found = yield* depot.latestWorkflow(`${owner}/${name}`, workflow).pipe(
    Effect.tapError(logFailure),
    Effect.orElseSucceed(() => Option.none<Workflow>()),
  );
  const status = Option.match(found, {
    onNone: () => undefined,
    onSome: (item) => (job ? jobOf(item, job)?.status : item.workflowStatus),
  });
  return depotBadge(job ? `${workflow}: ${job}` : workflow, status, format);
});
