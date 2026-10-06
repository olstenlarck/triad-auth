import { Cache, Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";

import { cached, resilient } from "./upstream";

export const BADGEN = "https://badgen.net";

export class BadgenError extends Schema.TaggedError<BadgenError>()("Socket.BadgenError", {
  cause: Schema.Defect(),
}) {}

export interface SocketInterface {
  readonly badge: (repo: string) => Effect.Effect<string, BadgenError>;
}

export class Socket extends Context.Service<Socket, SocketInterface>()("Badges.Socket") {}

// The badgen GitHub checks badge of the Socket report on master, saying passing and failing
// like the Depot badges instead of success and failure.
export const socketLayer = (url: string) =>
  Layer.effect(
    Socket,
    Effect.gen(function* () {
      const client = resilient(yield* HttpClient.HttpClient);

      const lookup = Effect.fn("Socket.lookup")(function* (repo: string) {
        const svg = yield* client
          .get(
            `${url}/github/checks/${repo}/master/Socket%20Security:%20Project%20Report?label=Socket%20Security&labelColor=black&icon=socket`,
          )
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.mapError((cause) => new BadgenError({ cause })),
          );
        return svg.replaceAll("success", "passing").replaceAll("failure", "failing");
      });

      const cache = yield* cached(lookup);

      return Socket.of({ badge: (repo) => Cache.get(cache, repo) });
    }),
  );
