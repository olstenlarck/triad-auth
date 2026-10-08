import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { vaultTags } from "../src/publishing";
import { env, network, registry } from "./utils";

const subject = (tag: string) =>
  Object.entries(vaultTags).find(([, vaultTag]) => vaultTag === tag)?.[0];

const claims: JWTPayload = {
  iss: "https://cloud.rwx.com/mint",
  aud: "npm:npm.wgw.lol",
  sub: subject("nightly"),
  run_id: "run_test",
  run_url: "https://cloud.rwx.com/mint/tunnckocorehq/runs/run_test",
  task_id: "task_test",
  task_url: "https://cloud.rwx.com/mint/tunnckocorehq/tasks/task_test",
};
const exchangeUrl = "https://npm.wgw.lol/-/npm/v1/oidc/token/exchange/package/@tunnckocore%2fcalc";
let privateKey: CryptoKey;
let jwks: { keys: object[] };
let net: ReturnType<typeof network>;
let app: ReturnType<typeof registry>;

const upstreamCalls = () => net.calls.filter((call) => call.url.startsWith(env.VLT_UPSTREAM_URL));

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "rwx-test", alg: "RS256" }] };
});

beforeEach(() => {
  net = network((call) => {
    if (call.url === "https://cloud.rwx.com/mint/.well-known/jwks.json") {
      return Response.json(jwks);
    }
    if (call.url === "https://api.github.com/user") {
      return Response.json({ login: "tunnckoCore" });
    }
    return new Response("{}", { status: 201 });
  });
  app = registry(net.fetch);
});

afterEach(() => app.dispose());

async function token(overrides: JWTPayload = {}, key = privateKey) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "rwx-test" })
    .setIssuedAt(overrides.iat)
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(key);
}

function latestToken() {
  return token({ sub: subject("latest") });
}

function exchange(bearer: string | undefined, url = exchangeUrl) {
  return app.request(url, {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

function publish(
  bearer: string,
  tag = "nightly",
  version = "0.1.3-nightly.20260904234045.abcdef0",
) {
  return app.request("https://npm.wgw.lol/@tunnckocore%2fcalc", {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "@tunnckocore/calc",
      versions: { [version]: { name: "@tunnckocore/calc", version } },
      "dist-tags": { [tag]: version },
    }),
  });
}

function setDistTag(bearer: string, tag: string, version: string) {
  return app.request(`https://npm.wgw.lol/-/package/@tunnckocore%2fcalc/dist-tags/${tag}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(version),
  });
}

const invalidClaims: JWTPayload[] = [
  { sub: undefined },
  { sub: "unknown-vault-subject" },
  { iss: "https://identity.depot.dev" },
  { iss: "https://attacker.example" },
  { aud: "https://npm.wgw.lol" },
  { aud: "npm:registry.npmjs.org" },
  { exp: 1 },
  { iat: Math.floor(Date.now() / 1000) - 20 * 60 },
];

describe("OIDC token exchange", () => {
  it("returns the verified RWX token for a scoped package", async () => {
    const bearer = await token();
    const response = await exchange(bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: bearer });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("issues a token that the publish route accepts", async () => {
    const { token: exchanged } = await (await exchange(await token())).json<{ token: string }>();
    expect((await publish(exchanged)).status).toBe(201);
    expect(upstreamCalls()[0].headers.get("authorization")).toBe("Bearer write-service-token");
  });

  it.each(invalidClaims)("rejects invalid identity claims %j", async (overrides) => {
    expect((await exchange(await token(overrides))).status).toBe(401);
  });

  it("rejects a missing bearer and a forged signature", async () => {
    expect((await exchange(undefined)).status).toBe(401);
    const forged = await generateKeyPair("RS256");
    expect((await exchange(await token({}, forged.privateKey))).status).toBe(401);
  });

  it("knows only @tunnckocore packages", async () => {
    const bearer = await token();
    for (const name of ["calc", "@other%2fcalc", "@tunnckocore%2f..%2fcalc"]) {
      const response = await exchange(bearer, `${exchangeUrl.replace(/[^/]+$/, "")}${name}`);
      expect(response.status).toBe(404);
    }
  });
});

describe("package visibility", () => {
  it("reports scoped packages as not public so pnpm skips provenance", async () => {
    const response = await app.request(
      "https://npm.wgw.lol/-/package/@tunnckocore%2fcalc/visibility",
      { method: "GET" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ public: false });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("knows only @tunnckocore packages", async () => {
    for (const name of ["calc", "@other%2fcalc"]) {
      const response = await app.request(`https://npm.wgw.lol/-/package/${name}/visibility`, {
        method: "GET",
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("CI publishing authorization", () => {
  it("verifies the signature and substitutes the worker token for a master nightly", async () => {
    expect((await publish(await token())).status).toBe(201);
    expect(upstreamCalls()).toHaveLength(1);
    expect(upstreamCalls()[0].url).toBe(
      "https://registry.vlt.io/tunnckocore/main/@tunnckocore%2fcalc",
    );
    expect(upstreamCalls()[0].headers.get("authorization")).toBe("Bearer write-service-token");
  });

  it("lets the prod vault publish stable versions as latest", async () => {
    expect((await publish(await latestToken(), "latest", "0.1.3")).status).toBe(201);
    expect((await setDistTag(await latestToken(), "latest", "0.1.3")).status).toBe(201);
  });

  it("keeps the nightly vault away from latest and the prod vault away from nightly", async () => {
    expect((await publish(await token(), "latest", "0.1.3")).status).toBe(403);
    expect((await setDistTag(await token(), "latest", "0.1.3")).status).toBe(403);
    expect((await publish(await latestToken())).status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it.each(invalidClaims)("rejects invalid identity claims %j", async (overrides) => {
    expect((await publish(await token(overrides))).status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("rejects a forged signature", async () => {
    const forged = await generateKeyPair("RS256");
    expect((await publish(await token({}, forged.privateKey))).status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("prevents a prerelease from reaching latest", async () => {
    expect((await publish(await latestToken(), "latest")).status).toBe(403);
    expect(
      (await setDistTag(await latestToken(), "latest", "0.1.3-nightly.1.abcdef0")).status,
    ).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("prevents a stable version from reaching nightly", async () => {
    expect((await publish(await token(), "nightly", "0.1.3")).status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("prevents CI tokens from writing other dist-tags", async () => {
    expect((await publish(await latestToken(), "beta", "0.1.3")).status).toBe(403);
    expect((await setDistTag(await latestToken(), "beta", "0.1.3")).status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("prevents CI tokens from deleting packages", async () => {
    const response = await app.request("https://npm.wgw.lol/@tunnckocore%2fcalc", {
      method: "DELETE",
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("keeps local GitHub token publishing available", async () => {
    expect((await publish("gho_local_cli_token", "latest", "0.1.3")).status).toBe(201);
    expect(upstreamCalls()[0].headers.get("authorization")).toBe("Bearer write-service-token");
  });
});

function put(path: string, bearer: string, body: string) {
  return app.request(`https://npm.wgw.lol${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body,
  });
}

describe("CI publish body", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await put("/@tunnckocore%2fcalc", await token(), "{");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid publish request" });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("rejects a packument without versions", async () => {
    const body = JSON.stringify({ "dist-tags": { nightly: "0.1.3-nightly.1.abcdef0" } });
    expect((await put("/@tunnckocore%2fcalc", await token(), body)).status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("writes only the package document itself", async () => {
    const body = JSON.stringify({ versions: {}, "dist-tags": {} });
    expect((await put("/@tunnckocore%2fcalc/extra", await token(), body)).status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });
});
