import { Cache, Effect, Exit, Schedule } from "effect";
import type { Duration } from "effect";
import { HttpClient } from "effect/http";

// Each attempt gets 5 seconds. Transport errors, timeouts, 408, 429, and 5xx are tried two more
// times, about 100ms and 200ms later, with jitter so isolates do not retry in step. Both upstreams
// are read-only lookups, so a repeat is safe.
const TIMEOUT = "5 seconds";
const RETRY = { times: 2, schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered) };

export const resilient = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(TIMEOUT)),
    HttpClient.retryTransient(RETRY),
  );

// The badges say max-age=60, so a successful lookup is kept for a minute in the isolate. A failure
// is kept for 5 seconds, so a failing upstream gets one lookup per key in that window instead of
// one per request. Cache never keeps an interrupted lookup. Concurrent requests for one key share
// one lookup.
const ttl = (exit: Exit.Exit<unknown, unknown>): Duration.Input =>
  Exit.isSuccess(exit) ? "60 seconds" : "5 seconds";
const CAPACITY = 1000;

export const cached = <Key, A, E>(lookup: (key: Key) => Effect.Effect<A, E>) =>
  Cache.makeWith(lookup, { capacity: CAPACITY, timeToLive: ttl });
