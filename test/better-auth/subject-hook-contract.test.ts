// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { describe, expect, it } from "vite-plus/test";

const resolver: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
  `${input.use}:${input.clientId}:${input.userId}:${input.defaultSubject}`;

const plugin = oauthProvider({
  consentPage: "/consent",
  loginPage: "/sign-in/",
  resolveSubjectIdentifier: resolver,
});

const entryUrl = new URL(import.meta.resolve("@better-auth/oauth-provider"));
const entrySource = readFileSync(entryUrl, "utf8");
const tokenSource = readFileSync(new URL("./introspect-DvHp2a64.mjs", entryUrl), "utf8");
const utilitySource = readFileSync(new URL("./utils-DO8lmoDw.mjs", entryUrl), "utf8");

describe("OAuth Provider exact-client subject hook", () => {
  it("exposes the resolver through the public options type", () => {
    expect(plugin.options.resolveSubjectIdentifier).toBe(resolver);
  });

  it("labels every OIDC-facing subject use", () => {
    expect(entrySource).toContain('resolveSubjectIdentifier(userId, client, opts, "logout_token")');
    expect(tokenSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "userinfo")');
    expect(tokenSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "id_token")');
  });

  it("enables UserInfo subject resolution without a pairwise secret", () => {
    expect(tokenSource).toContain(
      "const client = clientId && (opts.pairwiseSecret || opts.resolveSubjectIdentifier || hasUserInfoClaimExtension(opts))",
    );
    expect(tokenSource).toContain(
      "if ((opts.pairwiseSecret || opts.resolveSubjectIdentifier) && client) baseUserClaims.sub",
    );
  });

  it("passes the exact client ID and built-in default subject to the hook", () => {
    expect(utilitySource).toContain("clientId: client.clientId");
    expect(utilitySource).toContain("defaultSubject");
  });

  it("does not pairwise-rewrite introspection subjects", () => {
    const introspectionResolver = tokenSource.match(
      /async function resolveIntrospectionSub[\s\S]*?\n}\nasync function introspectEndpoint/,
    )?.[0];

    expect(introspectionResolver).toContain("return payload;");
    expect(introspectionResolver).not.toContain("resolveSubjectIdentifier(");
  });
});
