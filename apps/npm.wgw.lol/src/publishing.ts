import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import { BadRequest, Forbidden, Unauthorized } from "./errors";

// Package managers present the GitHub Actions OIDC token with audience `npm:<registry host>`,
// either as the publish bearer or at the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

export type PublishTag = "nightly" | "latest";

const issuer = "https://token.actions.githubusercontent.com";

// The workflow_ref claim names the workflow file and the ref it ran from. Only the two publishing
// workflows on master get a dist-tag: publish-nightly.yml may write nightly and publish-prod.yml
// may write latest. A pull request or another branch carries a different ref and is rejected.
export const workflowTags: Record<string, PublishTag> = {
  "tunnckoCoreHQ/monarch/.github/workflows/publish-nightly.yml@refs/heads/master": "nightly",
  "tunnckoCoreHQ/monarch/.github/workflows/publish-prod.yml@refs/heads/master": "latest",
};

const versionPatterns: Record<PublishTag, RegExp> = {
  nightly: /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/,
  latest: /^\d+\.\d+\.\d+$/,
};

const CiClaims = Schema.Struct({
  workflow_ref: Schema.Literals(Object.keys(workflowTags)),
});

const Packument = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
  "dist-tags": Schema.Record(Schema.String, Schema.String),
});

export class CiIdentity extends Context.Service<
  CiIdentity,
  { readonly verify: (token: string) => Effect.Effect<PublishTag, Unauthorized> }
>()("CiIdentity") {
  static readonly layer = Layer.effect(
    CiIdentity,
    Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;
      const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
        [customFetch]: fetch,
      });

      const verify = Effect.fn("CiIdentity.verify")(function* (token: string) {
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, keys, {
              issuer,
              audience: publishAudience,
              algorithms: ["RS256"],
              requiredClaims: ["exp", "iat", "workflow_ref"],
              maxTokenAge: "10m",
            }),
          catch: () => new Unauthorized(),
        });
        const claims = yield* Schema.decodeUnknownEffect(CiClaims)(payload).pipe(
          Effect.mapError(() => new Unauthorized()),
        );

        return workflowTags[claims.workflow_ref];
      });

      return CiIdentity.of({ verify });
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
