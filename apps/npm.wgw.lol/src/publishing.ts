import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import { BadRequest, Forbidden, Unauthorized } from "./errors";

const repository = "tunnckoCoreHQ/monarch";
const depotOrgId = "pcnr2v598s";
const subjectPrefix = `spiffe://identity.depot.dev/org/${depotOrgId}/ci/github/${repository}/ref/refs/heads/master/sandbox/`;

// Package managers request the Depot CI OIDC token with audience `npm:<registry host>` and
// exchange it at the registry; see the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

export type PublishTag = "nightly" | "latest";

// Depot CI tokens have no environment claim, so the workflow file decides the dist-tag:
// publish-nightly.yml may write nightly and publish-prod.yml may write latest. GitHub formats
// workflow_ref as owner/repo/.github/workflows/file.yml@ref; Depot's documented example omits the
// directory, so both forms are accepted.
const workflowTags: Record<string, PublishTag> = {
  "publish-nightly": "nightly",
  "publish-prod": "latest",
};
const workflowRef = new RegExp(
  `^${repository}/(?:\\.depot/workflows/)?(publish-nightly|publish-prod)\\.yml@refs/heads/master$`,
);

const versionPatterns: Record<PublishTag, RegExp> = {
  nightly: /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/,
  latest: /^\d+\.\d+\.\d+$/,
};

const DepotClaims = Schema.Struct({
  org_id: Schema.Literal(depotOrgId),
  repository: Schema.Literal(repository),
  repository_id: Schema.Literal("1299813376"),
  repository_owner_id: Schema.Literal("51462759"),
  ref: Schema.Literal("refs/heads/master"),
  sub: Schema.String.check(Schema.isStartingWith(subjectPrefix)),
  workflow_ref: Schema.String.check(Schema.isPattern(workflowRef)),
});

const Packument = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
  "dist-tags": Schema.Record(Schema.String, Schema.String),
});

export class DepotIdentity extends Context.Service<
  DepotIdentity,
  { readonly verify: (token: string) => Effect.Effect<PublishTag, Unauthorized> }
>()("DepotIdentity") {
  static readonly layer = Layer.effect(
    DepotIdentity,
    Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;
      const keys = createRemoteJWKSet(new URL("https://identity.depot.dev/keys"), {
        [customFetch]: fetch,
      });

      const verify = Effect.fn("DepotIdentity.verify")(function* (token: string) {
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, keys, {
              issuer: "https://identity.depot.dev",
              audience: publishAudience,
              algorithms: ["ES256", "ES384", "RS256"],
              requiredClaims: ["exp", "iat", "sub", "workflow_ref"],
              maxTokenAge: "10m",
            }),
          catch: () => new Unauthorized(),
        });
        const claims = yield* Schema.decodeUnknownEffect(DepotClaims)(payload).pipe(
          Effect.mapError(() => new Unauthorized()),
        );

        const [, workflow] = workflowRef.exec(claims.workflow_ref) ?? [];
        return workflowTags[workflow];
      });

      return DepotIdentity.of({ verify });
    }),
  );
}

// A CI token may publish one version under its own dist-tag, or point that dist-tag at a
// version, and nothing else.
export const validatePublishRequest = Effect.fn("Publishing.validate")(function* (
  request: Request,
  path: string,
  tag: PublishTag,
) {
  if (request.method !== "PUT") {
    return yield* new Forbidden();
  }

  const body: unknown = yield* Effect.tryPromise({
    try: () => request.clone().json(),
    catch: () => new BadRequest({ message: "Invalid publish request" }),
  });
  const versionPattern = versionPatterns[tag];

  if (path.startsWith("/-/package/")) {
    const isOwnTag = new RegExp(
      `^/-/package/@tunnckocore/[a-z0-9][a-z0-9._-]*/dist-tags/${tag}$`,
    ).test(path);
    if (!isOwnTag || typeof body !== "string" || !versionPattern.test(body)) {
      return yield* new Forbidden();
    }
    return;
  }

  if (!/^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*$/.test(path)) {
    return yield* new Forbidden();
  }
  const packument = yield* Schema.decodeUnknownEffect(Packument)(body).pipe(
    Effect.mapError(() => new Forbidden()),
  );

  const tags = Object.entries(packument["dist-tags"]);
  const versions = Object.keys(packument.versions);
  if (
    tags.length !== 1 ||
    tags[0][0] !== tag ||
    !versionPattern.test(tags[0][1]) ||
    versions.length !== 1 ||
    versions[0] !== tags[0][1]
  ) {
    return yield* new Forbidden();
  }
});
