import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { GitHub } from "../src/github";
import { configLayer } from "../src/index";
import { env, network } from "./utils";

// The real GitHub service on a test network, so each test runs the real client, retry, and
// decoding code.
function authorize(respond: Parameters<typeof network>[0]) {
  const net = network(respond);
  const layer = GitHub.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide([configLayer(env), Layer.succeed(FetchHttpClient.Fetch, net.fetch)]),
  );
  const run = Effect.gen(function* () {
    const github = yield* GitHub;
    return yield* github.authorize("gho_token");
  }).pipe(Effect.provide(layer));

  return { calls: net.calls, run };
}

describe("GitHub.authorize", () => {
  it.effect("accepts the allowed login in any case", () =>
    Effect.gen(function* () {
      const { calls, run } = authorize(() => Response.json({ login: "TUNNCKOCORE" }));
      yield* run;

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.github.com/user");
      expect(calls[0].headers.get("authorization")).toBe("Bearer gho_token");
      expect(calls[0].headers.get("x-github-api-version")).toBe("2026-03-10");
    }),
  );

  it.effect("forbids every other login", () =>
    Effect.gen(function* () {
      const { run } = authorize(() => Response.json({ login: "someone" }));
      const error = yield* Effect.flip(run);

      expect(error._tag).toBe("Forbidden");
    }),
  );

  it.effect("rejects a token that GitHub rejects", () =>
    Effect.gen(function* () {
      const { calls, run } = authorize(() => new Response(null, { status: 401 }));
      const error = yield* Effect.flip(run);

      expect(error._tag).toBe("Unauthorized");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("fails with 502 on a profile it cannot read", () =>
    Effect.gen(function* () {
      const { run } = authorize(() => Response.json({ name: "no login" }));
      const error = yield* Effect.flip(run);

      expect(error._tag).toBe("BadGateway");
    }),
  );

  it.effect("retries a GitHub outage two times with backoff, then fails with 502", () =>
    Effect.gen(function* () {
      const { calls, run } = authorize(() => new Response(null, { status: 503 }));
      const fiber = yield* Effect.forkChild(Effect.flip(run));

      yield* TestClock.adjust("100 millis");
      expect(calls).toHaveLength(2);

      yield* TestClock.adjust("200 millis");
      const error = yield* Fiber.join(fiber);

      expect(calls).toHaveLength(3);
      expect(error._tag).toBe("BadGateway");
    }),
  );

  it.effect("recovers when GitHub comes back during the retries", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const { run } = authorize(() => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 502 })
          : Response.json({ login: "tunnckoCore" });
      });
      const fiber = yield* Effect.forkChild(run);

      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(fiber);

      expect(attempts).toBe(2);
    }),
  );
});
