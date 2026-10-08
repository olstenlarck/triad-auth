import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

import type { Env } from "../src/env";
import { App, configLayer } from "../src/index";

export const env: Env = {
  ALLOWED_GITHUB_LOGIN: "tunnckoCore",
  COMMIT_SHA: "local",
  VLT_READ_TOKEN: "read-service-token",
  VLT_WRITE_TOKEN: "write-service-token",
  VLT_UPSTREAM_URL: "https://registry.vlt.io/tunnckocore/main/",
};

export type Fetch = typeof globalThis.fetch;

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly cf: unknown;
}

// The network the worker sees in tests: every outgoing request is recorded and answered by
// `respond`, so tests never touch the real GitHub or VLT.
export function network(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      cf: init?.cf,
    };
    calls.push(call);
    return respond(call);
  };

  // The Bun types in the root tsconfig add `preconnect` to the fetch type.
  const fetch: Fetch = Object.assign(send, { preconnect: () => undefined });
  return { calls, fetch };
}

// The registry app with the test bindings and the given network.
export function registry(fetch: Fetch) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    App.pipe(Layer.provide([configLayer(env), Layer.succeed(FetchHttpClient.Fetch, fetch)])),
    { disableLogger: true },
  );

  return {
    request: (url: string, init?: RequestInit) => handler(new Request(url, init)),
    dispose,
  };
}
