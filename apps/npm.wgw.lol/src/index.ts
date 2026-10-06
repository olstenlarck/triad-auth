import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import type { Env } from "./env";
import { BadGateway, BadRequest, MethodNotAllowed, NotFound, Unauthorized } from "./errors";
import { GitHub } from "./github";
import { DepotIdentity, validatePublishRequest } from "./publishing";
import { Vlt } from "./vlt";

const scopedPackage = /^@tunnckocore\/[a-z0-9][a-z0-9._-]*$/;

const decode = (value: string, onError: NotFound | BadRequest) =>
  Effect.try({ try: () => decodeURIComponent(value), catch: () => onError });

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

    return HttpRouter.add("GET", "/-/health", HttpServerResponse.json({ ok: true, link, commit }));
  }),
);

// Trusted publishing: npm-compatible clients POST the Depot CI OIDC token here and use the
// returned token as the bearer for the publish itself. VLT has no OIDC support, so this worker
// is the exchange endpoint. The verified Depot token is returned as-is; the proxy route verifies
// it again on every write.
const ExchangeRoute = HttpRouter.add(
  "POST",
  "/-/npm/v1/oidc/token/exchange/package/*",
  Effect.fn("Registry.exchange")(function* (request) {
    const depot = yield* DepotIdentity;
    const url = new URL(request.originalUrl);

    const name = yield* decode(
      url.pathname.slice("/-/npm/v1/oidc/token/exchange/package/".length),
      new BadRequest({ message: "Invalid package name" }),
    );
    if (!scopedPackage.test(name)) {
      return yield* new NotFound();
    }

    const bearer = bearerToken(request);
    if (!bearer) {
      return yield* new Unauthorized();
    }
    yield* depot.verify(bearer);

    return yield* HttpServerResponse.json({ token: bearer });
  }),
);

// pnpm asks for package visibility before attaching provenance. VLT packages are private and
// provenance would publish build metadata to Sigstore's public log, so answer "not public" and
// pnpm skips provenance without a warning. Publishing to npm is unaffected: pnpm asks npm there.
const VisibilityRoute = HttpRouter.add(
  "GET",
  "/-/package/:name/visibility",
  Effect.fn("Registry.visibility")(function* (request) {
    const url = new URL(request.originalUrl);
    const [, encodedName = ""] = /^\/-\/package\/(.+)\/visibility$/.exec(url.pathname) ?? [];

    const name = yield* decode(encodedName, new NotFound());
    if (!scopedPackage.test(name)) {
      return yield* new NotFound();
    }

    return yield* HttpServerResponse.json({ public: false });
  }),
);

const ProxyRoute = HttpRouter.add(
  "*",
  "/*",
  Effect.fn("Registry.proxy")(function* (request) {
    const vlt = yield* Vlt;
    const source = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError((cause) => new BadGateway({ message: "Bad gateway", cause })),
    );
    const path = yield* decode(new URL(source.url).pathname, new NotFound());

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

// A JWT bearer is a Depot CI OIDC token from a publishing workflow; any other bearer is a
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
    const depot = yield* DepotIdentity;
    const tag = yield* depot.verify(bearer);
    return yield* validatePublishRequest(source, path, tag);
  }

  const github = yield* GitHub;
  yield* github.authorize(bearer);
});

const Services = Layer.mergeAll(DepotIdentity.layer, Vlt.layer, GitHub.layer).pipe(
  Layer.provide(FetchHttpClient.layer),
);

// The services are built once with the router and provided to every request.
const Routes = Layer.mergeAll(HealthRoute, ExchangeRoute, VisibilityRoute, ProxyRoute).pipe(
  HttpRouter.provideRequest(Services),
);

// Bindings arrive with the first request, so each isolate builds the app once from them.
let web: ReturnType<typeof makeWebHandler> | undefined;

function makeWebHandler(env: Env) {
  const config = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
  return HttpRouter.toWebHandler(Routes.pipe(Layer.provide(config)), { disableLogger: true });
}

export default {
  fetch(request: Request, env: Env) {
    web ??= makeWebHandler(env);
    return web.handler(request);
  },
} satisfies ExportedHandler<Env>;
