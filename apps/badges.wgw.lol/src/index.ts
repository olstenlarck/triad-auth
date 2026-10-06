import { badgen } from "badgen";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
} from "effect/http";

import type { Env } from "./env";

const DEPOT_API = "https://api.depot.dev/depot.ci.v1.CIService";
const DEPOT_CI_PRODUCT = "https://depot.dev/products/ci";
const SEGMENT = /^[\w.-]+$/;

// The Depot logo from the depot.dev favicon, drawn on the left of the Depot CI badges.
const DEPOT_ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-96 -96 704 704"><path fill="#fff" d="M512 366.933V438.857H365.714C347.941 438.857 332.142 447.318 322.11 460.423C322.085 460.483 322.048 460.532 321.999 460.581C321.828 460.8 321.658 461.02 321.5 461.239L321.438 461.275C301.763 487.204 272.457 505.429 238.812 510.537C232.497 511.5 226.024 512 219.429 512H0V440.076H182.857C189.514 440.076 196.049 439.571 202.424 438.599L204.013 438.348C237.231 432.879 266.138 414.725 285.686 389.065L285.764 389.021L285.917 388.811C286.053 388.622 286.202 388.428 286.362 388.221C286.427 388.149 286.496 388.058 286.561 387.948C296.376 375.172 311.798 366.933 329.143 366.933H512ZM172.119 293.79C198.488 293.79 221.54 307.984 234.057 329.143C221.54 350.301 198.488 364.495 172.119 364.495H0V293.79H172.119ZM219.429 147.505C225.962 147.505 232.375 148 238.629 148.954L240.188 149.201C272.855 154.579 301.281 172.464 320.467 197.748L320.615 197.944L320.677 197.98C320.796 198.138 320.914 198.295 321.029 198.443L321.04 198.471L321.142 198.604C331.395 211.996 347.544 220.648 365.714 220.648H512V291.352H329.143C311.798 291.352 296.376 283.113 286.561 270.337C286.496 270.227 286.427 270.135 286.362 270.063C286.202 269.857 286.053 269.664 285.917 269.475L285.764 269.264L285.686 269.219C266.138 243.56 237.23 225.407 204.013 219.938L202.424 219.687C196.049 218.715 189.514 218.21 182.857 218.21H0V147.505H219.429ZM292.571 0C299.166 0 305.64 0.500048 311.955 1.4631C345.6 6.57101 374.906 24.796 394.581 50.725L394.643 50.7607C394.801 50.98 394.971 51.1998 395.142 51.419C395.19 51.4677 395.228 51.5166 395.252 51.5774C405.285 64.6821 421.083 73.1429 438.857 73.1429H512V145.067H402.286C384.941 145.067 369.519 136.827 359.704 124.051C359.639 123.941 359.57 123.85 359.505 123.777C359.345 123.571 359.196 123.378 359.06 123.189L358.907 122.979L358.829 122.933C339.281 97.2746 310.373 79.1211 277.156 73.6524L275.567 73.4012C269.191 72.4289 262.657 71.9238 256 71.9238H0V0H292.571Z"/></svg>',
)}`;

interface Badge {
  subject: string;
  status: string;
  color: string;
}

const STATUS: Record<string, Pick<Badge, "status" | "color">> = {
  finished: { status: "passing", color: "green" },
  failed: { status: "failing", color: "red" },
  cancelled: { status: "cancelled", color: "grey" },
  skipped: { status: "skipped", color: "grey" },
};

const WorkflowList = Schema.Struct({
  workflows: Schema.optionalKey(
    Schema.Array(Schema.Struct({ workflowId: Schema.String, workflowPath: Schema.String })),
  ),
});

const Workflow = Schema.Struct({
  orgId: Schema.String,
  repo: Schema.String,
  workflowId: Schema.String,
  workflowStatus: Schema.String,
  jobs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ jobId: Schema.String, jobKey: Schema.String, status: Schema.String }),
    ),
  ),
});

interface Workflow extends Schema.Schema.Type<typeof Workflow> {}

class DepotError extends Schema.TaggedError<DepotError>()("Depot.DepotError", {
  method: Schema.String,
  cause: Schema.Defect(),
}) {}

class BadgenError extends Schema.TaggedError<BadgenError>()("Socket.BadgenError", {
  cause: Schema.Defect(),
}) {}

interface DepotInterface {
  readonly latestWorkflow: (
    repo: string,
    workflow: string,
  ) => Effect.Effect<Option.Option<Workflow>, DepotError>;
}

class Depot extends Context.Service<Depot, DepotInterface>()("Badges.Depot") {}

const DepotLive = Layer.effect(
  Depot,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(DEPOT_API),
          HttpClientRequest.setHeader("connect-protocol-version", "1"),
        ),
      ),
      HttpClient.filterStatusOk,
    );

    // The token is read on each call, not when the layer is built, so a missing token fails only
    // the Depot routes and not /health, the Socket badge, or the redirects.
    const call = <S extends Schema.Constraint>(method: string, body: unknown, schema: S) =>
      Effect.gen(function* () {
        // A Depot organization token for pcnr2v598s.
        const token = yield* Config.Redacted("BADGES_DEPOT_TOKEN");
        const response = yield* client.execute(
          HttpClientRequest.post(`/${method}`, { body: HttpBody.jsonUnsafe(body) }).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        );
        return yield* HttpIncomingMessage.schemaBodyJson(schema)(response);
      }).pipe(
        Effect.mapError((cause) => new DepotError({ method, cause })),
        Effect.withSpan(`Depot.${method}`),
      );

    // The newest finished or failed workflow from a master push. In this repository only master
    // pushes have the push trigger, and skipping running workflows keeps the badge from flickering.
    const latestWorkflow = Effect.fn("Depot.latestWorkflow")(function* (
      repo: string,
      workflow: string,
    ) {
      const { workflows = [] } = yield* call(
        "ListWorkflows",
        { repo, name: workflow, trigger: "push", status: ["finished", "failed"], pageSize: 50 },
        WorkflowList,
      );
      const file = new RegExp(`(?:^|/)${workflow.replaceAll(".", "\\.")}\\.ya?ml$`);
      const found = workflows.find((item) => file.test(item.workflowPath));
      if (!found) {
        return Option.none();
      }
      return Option.some(yield* call("GetWorkflow", { workflowId: found.workflowId }, Workflow));
    });

    return Depot.of({ latestWorkflow });
  }),
);

function render(badge: Badge, format: string, icon?: string): Response {
  const headers = { "cache-control": "public, max-age=60" };
  if (format === "json") {
    return Response.json(badge, { headers });
  }
  return new Response(badgen({ ...badge, labelColor: "black", icon }), {
    headers: { ...headers, "content-type": "image/svg+xml; charset=utf-8" },
  });
}

// The badgen GitHub checks badge of the Socket report on master, saying passing and failing
// like the Depot badges instead of success and failure.
const socket = Effect.fn("Badges.socket")(function* (repo: string) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const svg = yield* client
    .get(
      `https://badgen.net/github/checks/${repo}/master/Socket%20Security:%20Project%20Report?label=Socket%20Security&labelColor=black&icon=socket`,
    )
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.mapError((cause) => new BadgenError({ cause })),
    );
  return new Response(svg.replaceAll("success", "passing").replaceAll("failure", "failing"), {
    headers: {
      "cache-control": "public, max-age=60",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
});

function health(sha: string): Response {
  const link =
    sha === "local"
      ? "https://github.com/tunnckoCoreHQ/monarch"
      : `https://github.com/tunnckoCoreHQ/monarch/commit/${sha}`;
  return Response.json({ ok: true, link, commit: sha });
}

const handle = Effect.fn("Badges.handle")(function* (request: Request, env: Env) {
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
    // A broken image helps nobody, so the badge shows "unknown" like the Depot badges.
    return yield* socket(`${owner}/${name}`).pipe(
      Effect.tapError(Effect.logError),
      Effect.orElseSucceed(() =>
        render({ subject: "Socket Security", status: "unknown", color: "grey" }, "svg"),
      ),
    );
  }
  if (!format && !job) {
    return Response.redirect(DEPOT_CI_PRODUCT, 302);
  }

  const depot = yield* Depot;
  const subject = job ? `${workflow}: ${job}` : workflow;

  if (!format) {
    // The redirect has no truthful fallback, so a Depot error stays a failure and answers 502.
    const found = yield* depot.latestWorkflow(`${owner}/${name}`, workflow);
    const foundJob = Option.getOrUndefined(found)?.jobs?.find(
      (item) => item.jobKey.split(":").at(-1) === job,
    );
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
    Effect.tapError(Effect.logError),
    Effect.orElseSucceed(() => Option.none<Workflow>()),
  );
  const status = Option.match(found, {
    onNone: () => undefined,
    onSome: (item) =>
      job
        ? item.jobs?.find((entry) => entry.jobKey.split(":").at(-1) === job)?.status
        : item.workflowStatus,
  });
  const known = status ? STATUS[status] : undefined;
  return render(
    known ? { subject, ...known } : { subject, status: "unknown", color: "grey" },
    format,
    DEPOT_ICON,
  );
});

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).pipe(
      Effect.provide(DepotLive),
      Effect.provide(FetchHttpClient.layer),
      // The Fetch reference caches globalThis.fetch on first use, so each request names it.
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      // The Worker bindings are the config source, so the token is read like any other Config.
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.catch((error) =>
        Effect.logError(error).pipe(Effect.as(new Response("Bad Gateway", { status: 502 }))),
      ),
      Effect.runPromise,
    );
  },
} satisfies ExportedHandler<Env>;
