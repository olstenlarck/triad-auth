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
  it("restores the exact landing privacy promise and optional scope manifest", () => {
    expect(landing).toContain("ASK FOR LESS.<br />REVEAL LESS.");
    expect(landing).toContain(
      "A client chooses its request. Triad shows the complete list before approval, and shares nothing beyond",
    );
    expect(landing).toContain(
      "No raw provider ID, email, handle, name, avatar, or provider access token.",
    );
    expect(landing).toContain("OPTIONAL PROFILE SCOPES");
    expect(landing).toContain("email + email_verified");
    expect(landing).toContain("preferred_username");
    expect(landing).toContain("<dt>name</dt><dd>name</dd>");
    expect(landing).toContain("<dt>avatar</dt><dd>picture</dd>");
  });

  it("restores provider-aware optional request controls with every option off", () => {
    expect(demo).toContain('<select id="demo-provider"');
    expect(demo.match(/<input type="checkbox" name="demo-scope"/g)).toHaveLength(4);
    expect(demo).toContain('value="email"');
    expect(demo).toContain('value="handle"');
    expect(demo).toContain('value="name"');
    expect(demo).toContain('value="avatar"');
    expect(demo).not.toMatch(/name="demo-scope"[^>]*checked/);
    expect(demo).toContain("canonicalScopeRequest");
    expect(demo).toContain("input.checked = false");
  });

  it("starts the selected provider through Better Auth DCR and social sign-in", () => {
    expect(demo).toContain("/api/auth/oauth2/register");
    expect(demo).toContain('token_endpoint_auth_method: "none"');
    expect(demo).toContain("scope: requestedScope");
    expect(demo).toContain("authorizationRequest");
    expect(demo).toContain("/api/auth/sign-in/social");
    expect(demo).toContain("provider: provider.id");
    expect(demo).toMatch(
      /fetch\(authorization,\s*\{\s*headers: \{ accept: "application\/json" \},\s*\}\)/,
    );
    expect(demo).toContain("oauth_query: signedAuthorization.search.slice(1)");
    expect(demo).not.toContain("/api/providers");
  });

  it("restores the v1 device authorization bay through Better Auth", () => {
    expect(demo).toContain("ONE REQUEST.<br /><span>TWO FLOWS.</span>");
    expect(demo).toContain("02 / DEVICE");
    expect(demo).toContain("DEVICE AUTHORIZATION");
    expect(demo).toContain('id="device-instructions"');
    expect(demo).toContain('id="verification-link"');
    expect(demo).toContain('id="device-start"');
    expect(demo).toContain("/api/auth/device/code");
    expect(demo).toContain("/api/auth/device/token");
    expect(demo).toContain("urn:ietf:params:oauth:grant-type:device_code");
    expect(demo).toContain("devicePollDecision");
    expect(demo).toContain('window.addEventListener("pagehide", stopDeviceFlow)');
    expect(demo).toContain('window.addEventListener("pageshow"');
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
    expect(consent).toContain('scope: inspected.scopes.join(" ")');
    expect(consent).toContain("oauth_query: inspected.oauthQuery");
    expect(consent).not.toContain("/api/consent/");
  });

  it("renders mandatory identity and requested optional disclosures", () => {
    expect(disclosures).toContain("identityDisclosures");
    expect(disclosures).toContain("profileDisclosures");
    expect(disclosures).toContain("EMAIL + VERIFICATION STATUS");
    expect(disclosures).toContain("preferred_username");
    expect(disclosures).toContain("picture");
    expect(disclosures).toContain('scopes.filter((value) => value !== "openid")');
    expect(disclosures).not.toContain('document.createElement("input")');
  });

  it("verifies and renders only optional claims present in the signed token", () => {
    expect(protocol).toContain("profile: verifiedProfile(payload)");
    expect(protocol).toContain('optionalString(payload, "email")');
    expect(protocol).toContain("email_verified");
    expect(callback).toContain('id="callback-profile"');
    expect(callback).toContain('id="callback-profile-claims"');
    expect(callback).toContain("renderProfileClaims(verified.profile)");
    expect(callback).toContain("SHARED CLAIMS");
    expect(callback).not.toMatch(/profile[\s\S]{0,240}innerHTML/);
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
