import { Cache, Config, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";

import { cached, resilient } from "./upstream";

export const DEPOT_API = "https://api.depot.dev/depot.ci.v1.CIService";

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

export interface Workflow extends Schema.Schema.Type<typeof Workflow> {}

export class DepotError extends Schema.TaggedError<DepotError>()("Depot.DepotError", {
  method: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface DepotInterface {
  readonly latestWorkflow: (
    repo: string,
    workflow: string,
  ) => Effect.Effect<Option.Option<Workflow>, DepotError>;
}

export class Depot extends Context.Service<Depot, DepotInterface>()("Badges.Depot") {}

export const depotLayer = (url: string) =>
  Layer.effect(
    Depot,
    Effect.gen(function* () {
      const client = resilient(
        (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(url),
              HttpClientRequest.setHeader("connect-protocol-version", "1"),
            ),
          ),
        ),
      );

      // The token is read on each call, not when the layer is built, so a missing token fails
      // only the Depot routes and not /health, the Socket badge, or the redirects.
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
      const lookup = Effect.fn("Depot.lookup")(function* (key: string) {
        // SEGMENT in handle keeps spaces out of repo and workflow, so the space splits the key.
        const [repo = "", workflow = ""] = key.split(" ");
        const { workflows = [] } = yield* call(
          "ListWorkflows",
          { repo, name: workflow, trigger: "push", status: ["finished", "failed"], pageSize: 50 },
          WorkflowList,
        );
        const file = new RegExp(
          `(?:^|/)${workflow.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")}\\.ya?ml$`,
        );
        const found = workflows.find((item) => file.test(item.workflowPath));
        if (!found) {
          return Option.none<Workflow>();
        }
        return Option.some(yield* call("GetWorkflow", { workflowId: found.workflowId }, Workflow));
      });

      const cache = yield* cached(lookup);

      return Depot.of({
        latestWorkflow: (repo, workflow) => Cache.get(cache, `${repo} ${workflow}`),
      });
    }),
  );
