import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import { BadRequest, Forbidden, Unauthorized } from "./errors";

// Package managers present the RWX OIDC token with audience `npm:<registry host>`, either as the
// publish bearer or at the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

export type PublishTag = "nightly" | "latest";

// RWX tokens carry no repository, ref, or workflow claim. The subject names the vault that issued
// the token, and both vaults are locked to master of this repository, so the vault decides the
// dist-tag: the monarch_nightly vault may write nightly and the monarch_prod vault may write latest.
export const vaultTags: Record<string, PublishTag> = {
  "org:tckdev:vault:monarch_nightly": "nightly",
  "org:tckdev:vault:monarch_prod": "latest",
};

const versionPatterns: Record<PublishTag, RegExp> = {
  nightly: /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/,
  latest: /^\d+\.\d+\.\d+$/,
};

const RwxClaims = Schema.Struct({
  sub: Schema.Literals(Object.keys(vaultTags)),
});

const Packument = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
  "dist-tags": Schema.Record(Schema.String, Schema.String),
});

export class RwxIdentity extends Context.Service<
  RwxIdentity,
  { readonly verify: (token: string) => Effect.Effect<PublishTag, Unauthorized> }
>()("RwxIdentity") {
  static readonly layer = Layer.effect(
    RwxIdentity,
    Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;
      const keys = createRemoteJWKSet(new URL("https://cloud.rwx.com/mint/.well-known/jwks.json"), {
        [customFetch]: fetch,
      });

      const verify = Effect.fn("RwxIdentity.verify")(function* (token: string) {
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, keys, {
              issuer: "https://cloud.rwx.com/mint",
              audience: publishAudience,
              algorithms: ["RS256"],
              requiredClaims: ["exp", "iat", "sub"],
              maxTokenAge: "10m",
            }),
          catch: () => new Unauthorized(),
        });
        const claims = yield* Schema.decodeUnknownEffect(RwxClaims)(payload).pipe(
          Effect.mapError(() => new Unauthorized()),
        );

        return vaultTags[claims.sub];
      });

      return RwxIdentity.of({ verify });
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
