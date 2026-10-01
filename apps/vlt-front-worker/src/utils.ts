import { createRemoteJWKSet, jwtVerify } from "jose";

const depotKeys = createRemoteJWKSet(new URL("https://identity.depot.dev/keys"));
const repository = "tunnckoCoreHQ/monarch";
const repositoryId = "1299813376";
const repositoryOwnerId = "51462759";

// Package managers request the Depot CI OIDC token with audience `npm:<registry host>` and
// exchange it at the registry; see the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

type PublishTag = "nightly" | "latest";

const versionPatterns: Record<PublishTag, RegExp> = {
  nightly: /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/,
  latest: /^\d+\.\d+\.\d+$/,
};

// Depot CI issues one token shape for every job, so only the repository and the master ref are
// trusted here. Which dist-tag a request may write follows from the version it publishes.
export async function verifyPublishToken(token: string): Promise<void> {
  const { payload } = await jwtVerify(token, depotKeys, {
    issuer: "https://identity.depot.dev",
    audience: publishAudience,
    algorithms: ["ES256", "ES384", "RS256"],
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: "10m",
  });

  if (
    payload.repository !== repository ||
    payload.repository_id !== repositoryId ||
    payload.repository_owner_id !== repositoryOwnerId ||
    payload.ref !== "refs/heads/master"
  ) {
    throw new Error("Untrusted publishing repository or ref");
  }
}

function isTaggedVersion(tag: unknown, version: unknown): boolean {
  return (
    (tag === "nightly" || tag === "latest") &&
    typeof version === "string" &&
    versionPatterns[tag].test(version)
  );
}

export async function validatePublishRequest(request: Request, path: string): Promise<boolean> {
  if (request.method !== "PUT") {
    return false;
  }

  const body: unknown = await request.clone().json();
  if (path.startsWith("/-/package/")) {
    const tag = /^\/-\/package\/@tunnckocore\/[a-z0-9][a-z0-9._-]*\/dist-tags\/([a-z]+)$/.exec(
      path,
    )?.[1];
    return isTaggedVersion(tag, body);
  }

  if (!/^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*$/.test(path)) {
    return false;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("versions" in body) ||
    !("dist-tags" in body)
  ) {
    return false;
  }

  const versions = body.versions;
  const tags = body["dist-tags"];
  if (
    typeof versions !== "object" ||
    versions === null ||
    typeof tags !== "object" ||
    tags === null
  ) {
    return false;
  }

  const entries = Object.entries(tags);
  return (
    entries.length === 1 &&
    isTaggedVersion(entries[0][0], entries[0][1]) &&
    Object.keys(versions).length === 1 &&
    Object.keys(versions)[0] === entries[0][1]
  );
}
