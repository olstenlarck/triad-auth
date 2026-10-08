import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import type { Env } from "./env";
import { errorResponse, MethodNotAllowed, NotFound, Unauthorized } from "./errors";
import { GitHub } from "./github";
import { CiIdentity, validatePublishRequest } from "./publishing";
import { Vlt } from "./vlt";

const scopedPackage = /^@tunnckocore\/[a-z0-9][a-z0-9._-]*$/;

const bearerToken = (request: HttpServerRequest.HttpServerRequest) =>
  /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];

// Registry paths never start with "/-/health", so this cannot shadow a package.
const HealthRoute = Layer.unwrap(
  Effect.gen(function* () {
    const commit = yield* Config.String("COMMIT_SHA");
    const link =
      commit === "local"
        ? "https://github.com/tunnckoCoreHQ/monarch"
        : `https://github.com/tunnckoCoreHQ/monarch/commit/${commit}`;

    return HttpRouter.add(
      "GET",
      "/-/health",
      HttpServerResponse.jsonUnsafe({ ok: true, link, commit }),
    );
  }),
);

// Trusted publishing: npm-compatible clients POST the GitHub Actions OIDC token here and use the
// returned token as the bearer for the publish itself. VLT has no OIDC support, so this worker
// is the exchange endpoint. The verified token is returned as-is; the proxy route verifies
// it again on every write.
const ExchangeRoute = HttpRouter.add(
  "POST",
  "/-/npm/v1/oidc/token/exchange/package/*",
  Effect.fn("Registry.exchange")(function* (request) {
    const ci = yield* CiIdentity;
    const { "*": name = "" } = yield* HttpRouter.params;
    if (!scopedPackage.test(name)) {
      return yield* new NotFound();
    }

    const bearer = bearerToken(request);
    if (!bearer) {
      return yield* new Unauthorized();
    }
    yield* ci.verify(bearer);

    return HttpServerResponse.jsonUnsafe({ token: bearer });
  }),
);

// pnpm asks for package visibility before attaching provenance. VLT packages are private and
// provenance would publish build metadata to Sigstore's public log, so answer "not public" and
// pnpm skips provenance without a warning. Publishing to npm is unaffected: pnpm asks npm there.
const VisibilityRoute = HttpRouter.add(
  "GET",
  "/-/package/:name/visibility",
  Effect.fn("Registry.visibility")(function* () {
    const { name = "" } = yield* HttpRouter.params;
    if (!scopedPackage.test(name)) {
      return yield* new NotFound();
    }

    return HttpServerResponse.jsonUnsafe({ public: false });
  }),
);

const ProxyRoute = HttpRouter.add(
  "*",
  "/*",
  Effect.fn("Registry.proxy")(function* (request) {
    const vlt = yield* Vlt;
    const source = yield* HttpServerRequest.toWeb(request);
    // The router already answered 404 for a path that does not decode.
    const path = decodeURIComponent(new URL(source.url).pathname);

    const isPackagePath = /^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*(?:\/.*)?$/.test(path);
    const isDistTagPath =
      /^\/-\/package\/@tunnckocore\/[a-z0-9][a-z0-9._-]*\/dist-tags(?:\/.*)?$/.test(path);
    const hasTraversal = path.split("/").some((segment) => segment === "." || segment === "..");
    if ((!isPackagePath && !isDistTagPath) || hasTraversal) {
      return yield* new NotFound();
    }

    const isRead = request.method === "GET" || request.method === "HEAD";
    const isWrite =
      request.method === "PUT" || request.method === "POST" || request.method === "DELETE";
    if (!isRead && !isWrite) {
      return yield* new MethodNotAllowed();
    }

    if (isWrite) {
      yield* authorizeWrite(request, source, path);
    }

    const response = yield* vlt.forward(source, {
      access: isRead ? "read" : "write",
      path,
      isDistTagPath,
    });
    return HttpServerResponse.raw(response);
  }),
);

// A JWT bearer is a GitHub Actions OIDC token from a publishing job; any other bearer is a
// GitHub token from a local publish.
const authorizeWrite = Effect.fn("Registry.authorizeWrite")(function* (
  request: HttpServerRequest.HttpServerRequest,
  source: Request,
  path: string,
) {
  const bearer = bearerToken(request);
  if (!bearer) {
    return yield* new Unauthorized();
  }

  if (bearer.split(".").length === 3) {
    const ci = yield* CiIdentity;
    const tag = yield* ci.verify(bearer);
    return yield* validatePublishRequest(source, path, tag);
  }

  const github = yield* GitHub;
  yield* github.authorize(bearer);
});

const Services = Layer.mergeAll(CiIdentity.layer, Vlt.layer, GitHub.layer).pipe(
  Layer.provide(FetchHttpClient.layer),
);

// A failure that is not one of our errors, such as an unparsable URL or a defect, would reach
// the client as an empty response. This gives it the same JSON shape as every other error.
const fallbackErrors: Record<number, string> = {
  400: "Bad request",
  404: "Not found",
  500: "Internal server error",
  503: "Service unavailable",
};

const JsonErrors = HttpRouter.middleware(
  (effect) =>
    Effect.catchCause(effect, (cause) =>
      Effect.flatMap(HttpServerError.causeResponse(cause), ([response]) => {
        if (response.body._tag !== "Empty") {
          return Effect.failCause(cause);
        }

        const fallback = errorResponse(
          response.status,
          fallbackErrors[response.status] ?? "Request failed",
        );
        return response.status >= 500
          ? Effect.as(Effect.logError(cause), fallback)
          : Effect.succeed(fallback);
      }),
    ),
  { global: true },
);

// The services are built once with the router and provided to every request. The bindings
// and the outgoing fetch come from outside, so tests can supply their own.
export const App = Layer.mergeAll(HealthRoute, ExchangeRoute, VisibilityRoute, ProxyRoute).pipe(
  HttpRouter.provideRequest(Services),
  Layer.merge(JsonErrors),
);

export const configLayer = (env: Env) => ConfigProvider.layer(ConfigProvider.fromUnknown(env));

// Bindings arrive with the first request, so each isolate builds the app once from them.
let web: ReturnType<typeof makeWebHandler> | undefined;

function makeWebHandler(env: Env) {
  return HttpRouter.toWebHandler(App.pipe(Layer.provide(configLayer(env))), {
    disableLogger: true,
  });
}

export default {
  fetch(request: Request, env: Env) {
    web ??= makeWebHandler(env);
    return web.handler(request);
  },
} satisfies ExportedHandler<Env>;
