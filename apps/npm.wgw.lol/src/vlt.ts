import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { BadGateway } from "./errors";

const badGateway = (cause: unknown) => new BadGateway({ message: "Bad gateway", cause });

export interface ForwardOptions {
  readonly access: "read" | "write";
  // The decoded pathname.
  readonly path: string;
  readonly isDistTagPath: boolean;
}

// The VLT registry behind npm.wgw.lol. It streams request and response bodies and sets
// Cloudflare cache options, so it calls fetch directly instead of going through HttpClient.
export class Vlt extends Context.Service<
  Vlt,
  {
    readonly forward: (
      request: Request,
      options: ForwardOptions,
    ) => Effect.Effect<Response, BadGateway>;
  }
>()("Vlt") {
  static readonly layer = Layer.effect(
    Vlt,
    Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;
      const upstreamUrl = yield* Config.String("VLT_UPSTREAM_URL");
      const tokens = {
        read: yield* Config.Redacted("VLT_READ_TOKEN"),
        write: yield* Config.Redacted("VLT_WRITE_TOKEN"),
      };

      const forward = Effect.fn("Vlt.forward")(function* (
        request: Request,
        options: ForwardOptions,
      ) {
        const url = new URL(request.url);
        const isTarball = options.path.includes("/-/") && options.path.endsWith(".tgz");
        const isRead = options.access === "read";

        // VLT stores dist-tags under the double-encoded package name.
        const upstreamPath = options.isDistTagPath
          ? url.pathname.replace(/(%40|@)tunnckocore%2f/i, "$1tunnckocore%252F")
          : url.pathname;
        const upstream = new URL(upstreamPath.replace(/^\/+/, ""), upstreamUrl);
        upstream.search = url.search;

        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.set("authorization", `Bearer ${Redacted.value(tokens[options.access])}`);

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(upstream, {
              method: request.method,
              headers,
              body: request.body,
              redirect: "follow",
              signal,
              cf:
                isRead && isTarball
                  ? {
                      cacheEverything: true,
                      cacheTtl: 31_536_000,
                    }
                  : undefined,
            }),
          catch: badGateway,
        });

        if (!isRead || !response.ok) {
          return response;
        }

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set(
          "cache-control",
          isTarball ? "public, max-age=31536000, immutable" : "public, max-age=60",
        );

        if (
          isTarball ||
          request.method === "HEAD" ||
          !response.headers.get("content-type")?.includes("json")
        ) {
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }

        // Packument tarball URLs point at VLT; rewrite them to this registry.
        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: badGateway,
        });
        responseHeaders.delete("content-length");
        responseHeaders.delete("etag");

        return new Response(body.replaceAll(upstreamUrl, `${url.origin}/`), {
          status: response.status,
          headers: responseHeaders,
        });
      });

      return Vlt.of({ forward });
    }),
  );
}
