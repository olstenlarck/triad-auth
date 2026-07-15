// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const demo = source("../../src/pages/demo/index.astro");
const callback = source("../../src/pages/demo/callback.astro");
const consent = source("../../src/pages/consent.astro");
const account = source("../../src/pages/me.astro");
const landing = source("../../src/pages/index.astro");
const protocol = source("../../src/scripts/demo-protocol.ts");
const disclosures = source("../../src/scripts/disclosure-controls.ts");

describe("preserved Better Auth UI wiring", () => {
  it("removes unsupported profile scope controls and claims", () => {
    for (const value of [demo, callback, consent, landing, protocol, disclosures]) {
      expect(value).not.toMatch(
        /demo-scope|OPTIONAL PROFILE SCOPES|email_verified|preferred_username/,
      );
    }
  });

  it("starts the demo through Better Auth DCR and authorization endpoints", () => {
    expect(demo).toContain("/api/auth/oauth2/register");
    expect(demo).toContain('token_endpoint_auth_method: "none"');
    expect(demo).toContain('scope: "openid"');
    expect(demo).not.toContain("/api/providers");
  });

  it("exchanges the callback code at Better Auth and signs out through Better Auth", () => {
    expect(callback).toContain("client_id");
    expect(callback).toContain("resource");
    expect(callback).toContain("/api/auth/sign-out");
    expect(callback).not.toContain("/session/logout");
  });

  it("posts the exact inspected signed query to Better Auth consent", () => {
    expect(consent).toContain("inspectOAuthQuery(location.search)");
    expect(consent).toContain("/api/auth/oauth2/public-client");
    expect(consent).toContain("/api/auth/oauth2/consent");
    expect(consent).toContain("oauth_query: inspected.oauthQuery");
    expect(consent).not.toContain("/api/consent/");
  });

  it("uses Better Auth session, account, consent, and sign-out contracts", () => {
    expect(account).toContain("/api/auth/get-session");
    expect(account).toContain("/api/auth/list-accounts");
    expect(account).toContain("/api/auth/oauth2/get-consents");
    expect(account).toContain("/api/auth/oauth2/delete-consent");
    expect(account).toContain("/api/auth/sign-in/social");
    expect(account).toContain("/api/auth/sign-out");
    expect(account).not.toMatch(/\/api\/me|\/session\/logout/);
  });

  it("describes delete-consent as consent removal rather than token revocation", () => {
    expect(account).toContain("REMOVE CONSENT");
    expect(account).toContain("Existing tokens may remain valid until expiry");
    expect(account).toMatch(/Sign out\s+separately/);
    expect(account).not.toContain('button.textContent = "REVOKE"');
  });
});
