import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

import { DEPOT_API, depotLayer } from "./depot";
import type { Depot } from "./depot";
import type { Env } from "./env";
import { handle, logFailure } from "./handle";
import { BADGEN, socketLayer } from "./socket";
import type { Socket } from "./socket";

export const liveLayer = Layer.mergeAll(depotLayer(DEPOT_API), socketLayer(BADGEN)).pipe(
  Layer.provide(FetchHttpClient.layer),
);

// One runtime per isolate, so the caches outlive a single request. The Worker bindings are the
// config source, so the token is read like any other Config. Any failure left, a thrown error
// included, answers 502 like the worker did before Effect.
export function makeWorker(layer: Layer.Layer<Depot | Socket>) {
  let runtime: ManagedRuntime.ManagedRuntime<Depot | Socket, never> | undefined;
  return {
    fetch(request: Request, env: Env): Promise<Response> {
      runtime ??= ManagedRuntime.make(layer);
      return runtime.runPromise(
        handle(request, env).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Effect.tapError(logFailure),
          Effect.tapDefect((defect) => Effect.logError("Request failed", String(defect))),
          Effect.catchCause(() => Effect.succeed(new Response("Bad Gateway", { status: 502 }))),
          Effect.annotateLogs({ path: new URL(request.url).pathname }),
        ),
      );
    },
  };
}
