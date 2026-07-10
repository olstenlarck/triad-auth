import { expect, it } from "vitest";

declare const process: {
  getBuiltinModule(name: "node:fs"): {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: "utf8"): string;
  };
};

const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
const readFile = async (path: string, _encoding: "utf8") => readFileSync(path, "utf8");
const applicationSources = [
  "src/components/Shell.astro",
  "src/pages/index.astro",
  "src/pages/me.astro",
  "src/pages/consent.astro",
  "src/pages/device/verify.astro",
  "src/pages/demo/index.astro",
  "src/pages/demo/callback.astro",
];
const readApplicationSources = async () => (await Promise.all(
  applicationSources.map((path) => readFile(path, "utf8")),
)).join("\n");

it("builds both demo entry points", async () => {
  await expect(readFile("dist/demo/index.html", "utf8")).resolves.toContain("TRY THE BROKER");
  await expect(readFile("dist/demo/callback/index.html", "utf8")).resolves.toContain("VERIFYING IDENTITY");
});

it("ships and links a local switchboard favicon", async () => {
  const shell = await readFile("src/components/Shell.astro", "utf8");

  expect(existsSync("public/favicon.svg")).toBe(true);
  expect(shell).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
});

it("seeds the built-in demo without encoding an environment-specific callback", async () => {
  const migration = await readFile("migrations/0001_init.sql", "utf8");

  expect(migration).toContain(
    "VALUES ('triad-demo', 'Triad demo', '[]', '[\"github\"]', unixepoch());",
  );
  expect(migration).not.toContain("'local-dev'");
  expect(migration).not.toContain("localhost");
  expect(migration).not.toContain('["google","github","x"]');
});

it("implements complete PKCE and device demo contracts", async () => {
  const [demo, callback, protocol] = await Promise.all([
    readFile("src/pages/demo/index.astro", "utf8"),
    readFile("src/pages/demo/callback.astro", "utf8"),
    readFile("src/scripts/demo-protocol.ts", "utf8"),
  ]);

  expect(demo).toContain("createPkce");
  expect(demo).toContain("fetchDiscovery");
  expect(demo.match(/sessionStorage\.setItem/g)).toHaveLength(2);
  expect(demo).toContain('code_challenge_method: "S256"');
  expect(demo).toContain("urn:ietf:params:oauth:grant-type:device_code");
  expect(demo).toContain("authorization_pending");
  expect(demo).toContain("slow_down");
  expect(demo.match(/This device code expired\. Start a new device flow\.[\s\S]{0,180}deviceStart\.textContent = "START NEW DEVICE FLOW";/g) ?? []).toHaveLength(2);
  expect(demo).toContain("verifyIdentityToken");
  expect(callback).toContain("state !== expectedState");
  expect(callback.indexOf("state !== expectedState")).toBeLessThan(callback.indexOf("fetch("));
  expect(callback).toContain("verifyIdentityToken");
  expect(`${demo}\n${callback}`).toContain("pairwise_sub");
  expect(`${demo}\n${callback}`).toContain("account_sub");
  expect(`${demo}\n${callback}`).toContain("provider_sub");
  expect(`${demo}\n${callback}`).toContain("Provider-global");
  expect(protocol).toContain('from "jose"');
  expect(protocol).toContain('algorithms: ["ES256"]');
});

it("submits transaction-bound CSRF tokens from both product forms", async () => {
  const [consent, device] = await Promise.all([
    readFile("src/pages/consent.astro", "utf8"),
    readFile("src/pages/device/verify.astro", "utf8"),
  ]);

  expect(consent).toContain("csrf_token");
  expect(consent).toContain('"content-type": "application/x-www-form-urlencoded"');
  expect(consent).toContain("without exposing the upstream ID");
  expect(device).toContain('type="hidden" name="provider"');
  expect(device).toContain('type="hidden" name="csrf_token"');
  expect(device).not.toContain('type="radio"');
  expect(device).not.toContain('value="google"');
  expect(device).not.toContain('value="x"');
});

it("keeps device verification navigation under same-origin JavaScript control", async () => {
  const device = await readFile("src/pages/device/verify.astro", "utf8");
  const submitHandler = device.slice(device.indexOf('form.addEventListener("submit"'));

  expect(submitHandler.indexOf("event.preventDefault();")).toBeLessThan(submitHandler.indexOf("if (!csrf.value)"));
  expect(submitHandler).toContain('fetch("/device/verify"');
  expect(submitHandler).toContain('"content-type": "application/x-www-form-urlencoded"');
  expect(submitHandler).toContain("redirect_to?: string");
  expect(submitHandler).toContain("location.assign(body.redirect_to)");
});

it("aborts device requests and prevents rescheduling after pagehide", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");

  expect(demo).toContain("let stopped = false");
  expect(demo).toContain("new AbortController()");
  expect(demo).toContain("deviceController.abort()");
  expect(demo.match(/signal: deviceController\.signal/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(demo.match(/if \(stopped\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(demo).toContain('window.addEventListener("pagehide", stopDeviceFlow)');
});

it("uses accurate consent action labels and a stable recovery route", async () => {
  const consent = await readFile("src/pages/consent.astro", "utf8");

  expect(consent).toContain('id="consent-restart"');
  expect(consent).toContain('href="/demo/"');
  expect(consent).toContain('const active = action === "approve" ? approve : deny');
  expect(consent).toContain("active.textContent = action ===");
  expect(consent).toContain('approve.textContent = "APPROVE REQUEST"');
  expect(consent).toContain('deny.textContent = "DENY REQUEST"');
  expect(consent).not.toContain("approve.textContent = action ===");
});

it("presents Triad rather than a GitHub-only broker", async () => {
  const landing = await readFile("src/pages/index.astro", "utf8");

  expect(landing).not.toContain("GitHub broker");
  expect(landing).toContain("GOOGLE");
  expect(landing).toContain("GITHUB");
  expect(landing).toContain("TWITTER");
  expect(landing).not.toContain("github:107691503");
  expect(landing).toContain("prv_twitter_R4");
});

it("uses twitter and never x as provider vocabulary", async () => {
  const ui = await readApplicationSources();

  expect(ui).not.toMatch(/provider[=:][\s]*["']x["']/i);
  expect(ui).toContain("twitter");
  expect(ui).not.toContain("—");
});

it("loads provider capabilities and sends one canonical demo scope request", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");

  expect(demo).toContain("fetchProviderCapabilities");
  expect(demo).toContain("canonicalScopeRequest");
  expect(demo).toContain('name="demo-provider"');
  expect(demo).toContain('name="demo-scope"');
  expect(demo).toContain('value="email"');
  expect(demo).toContain('value="handle"');
  expect(demo).toContain('value="name"');
  expect(demo).toContain('value="avatar"');
  expect(demo).toContain("provider: selectedProvider.id");
  expect(demo).toContain("scope: requestedScope");
  expect(demo).not.toContain('provider: "github"');
});

it("populates account sign-in actions from enabled providers", async () => {
  const account = await readFile("src/pages/me.astro", "utf8");

  expect(account).toContain("fetchProviderCapabilities");
  expect(account).toContain("/session/start/${provider.id}");
  expect(account).toContain('providerActions.textContent = "Sign-in providers could not be loaded."');
  expect(account).not.toContain('href="/session/start/github"');
});

it("restores demo controls without replacing a browser start error", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");
  const recovery = demo.slice(demo.indexOf('message(browserStatus, "The authorization request'));

  expect(demo).toContain("function updateRequestControls(updateStatus = true)");
  expect(recovery).toContain("updateRequestControls(false)");
});

it("renders transaction-bound provider and mandatory requested claims without consent checkboxes", async () => {
  const [consent, device] = await Promise.all([
    readFile("src/pages/consent.astro", "utf8"),
    readFile("src/pages/device/verify.astro", "utf8"),
  ]);

  expect(consent).toContain("body.provider");
  expect(consent).toContain("body.scopes");
  expect(consent).toContain("renderDisclosures");
  expect(consent).not.toContain('type="checkbox"');
  expect(consent).toContain('act("approve")');
  expect(consent).toContain('act("deny")');
  expect(device).toContain("body.provider");
  expect(device).toContain("body.scopes");
  expect(device).toContain("renderDisclosures");
  expect(device).toContain('id="device-disclosure" class="device-disclosure" hidden');
  expect(device).toContain("disclosureBox.hidden = false");
  expect(device).not.toContain('type="checkbox"');
  expect(device).not.toContain('value="github"');
});

it("renders verified optional claims through text content", async () => {
  const [demo, callback] = await Promise.all([
    readFile("src/pages/demo/index.astro", "utf8"),
    readFile("src/pages/demo/callback.astro", "utf8"),
  ]);

  expect(demo).toContain("identity.profile");
  expect(callback).toContain("verified.profile");
  expect(`${demo}\n${callback}`).not.toMatch(/profile[\s\S]{0,240}innerHTML/);
});

it("keeps navigation and copy provider-neutral outside provider context", async () => {
  const files = await Promise.all(applicationSources.map((path) => readFile(path, "utf8")));
  const ui = files.join("\n");

  expect(files[0]).toContain('href="/demo/"');
  expect(ui).not.toContain("—");
});

it("caps long transaction headings at narrow viewports", async () => {
  const css = await readFile("src/styles/global.css", "utf8");
  const mobile = css.slice(
    css.indexOf("@media (max-width: 760px)"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );

  expect(mobile).toContain("#consent-title { font-size: clamp(2.2rem, 11vw, 3.7rem); }");
  expect(mobile).toContain("#callback-title { font-size: clamp(2.8rem, 14vw, 3.7rem); }");
  expect(mobile).toContain(".device-app { flex-direction: column; }");
});

it("gives header and standalone links a minimum touch size", async () => {
  const css = await readFile("src/styles/global.css", "utf8");

  expect(css).toMatch(/\.wordmark,\s*\.site-header nav a,\s*\.text-link\s*\{[^}]*min-width: 2\.75rem;[^}]*min-height: 2\.75rem;/s);
});
