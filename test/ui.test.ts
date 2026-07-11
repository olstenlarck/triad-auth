import { expect, it } from "vite-plus/test";

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
const readApplicationSources = async () =>
  (await Promise.all(applicationSources.map((path) => readFile(path, "utf8")))).join("\n");

it("builds both demo entry points", async () => {
  await expect(readFile("dist/demo/index.html", "utf8")).resolves.toContain("TRY TRIAD");
  await expect(readFile("dist/demo/callback/index.html", "utf8")).resolves.toContain(
    "VERIFYING IDENTITY",
  );
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
  expect(
    demo.match(
      /This device code expired\. Start a new device flow\.[\s\S]{0,180}deviceStart\.textContent = "START NEW DEVICE FLOW";/g,
    ) ?? [],
  ).toHaveLength(2);
  expect(demo).toContain("verifyIdentityToken");
  expect(callback).toContain("state !== expectedState");
  const callbackFlow = callback.slice(callback.indexOf("if (!expectedState"));
  expect(callbackFlow.indexOf("state !== expectedState")).toBeLessThan(
    callbackFlow.indexOf("fetch("),
  );
  expect(callback).toContain("verifyIdentityToken");
  expect(`${demo}\n${callback}`).toContain("pairwise_sub");
  expect(`${demo}\n${callback}`).toContain("account_sub");
  expect(`${demo}\n${callback}`).toContain("provider_sub");
  expect(`${demo}\n${callback}`).toContain("Provider-global");
  expect(protocol).toContain('from "jose"');
  expect(protocol).toContain('algorithms: ["ES256"]');
});

it("submits transaction-bound CSRF tokens from both product forms", async () => {
  const [consent, device, disclosures] = await Promise.all([
    readFile("src/pages/consent.astro", "utf8"),
    readFile("src/pages/device/verify.astro", "utf8"),
    readFile("src/scripts/disclosure-controls.ts", "utf8"),
  ]);

  expect(consent).toContain("csrf_token");
  expect(consent).toContain('"content-type": "application/x-www-form-urlencoded"');
  expect(disclosures).toContain("without exposing its raw account ID");
  expect(device).toContain('type="hidden" name="provider"');
  expect(device).toContain('type="hidden" name="csrf_token"');
  expect(device).not.toContain('type="radio"');
  expect(device).not.toContain('value="google"');
  expect(device).not.toContain('value="x"');
  expect(disclosures).not.toContain('document.createElement("input")');
  expect(disclosures).not.toContain("disclosure-switch");
});

it("keeps device verification navigation under same-origin JavaScript control", async () => {
  const device = await readFile("src/pages/device/verify.astro", "utf8");
  const submitHandler = device.slice(device.indexOf('form.addEventListener("submit"'));

  expect(submitHandler.indexOf("event.preventDefault();")).toBeLessThan(
    submitHandler.indexOf("if (!csrf.value)"),
  );
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
  expect(demo.match(/if \(stopped\)\s*\{\s*return;\s*\}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(demo).toContain('window.addEventListener("pagehide", stopDeviceFlow)');
});

it("uses accurate consent action labels and a stable recovery route", async () => {
  const consent = await readFile("src/pages/consent.astro", "utf8");

  expect(consent).toContain('id="consent-restart"');
  expect(consent).toContain('href="/demo/"');
  expect(consent).toContain('const active = action === "approve" ? approve : deny');
  expect(consent).toContain("active.textContent = action ===");
  expect(consent).toContain('approve.textContent = "APPROVE CONNECTION"');
  expect(consent).toContain('deny.textContent = "CANCEL"');
  expect(consent).not.toContain("approve.textContent = action ===");
  expect(consent).toContain("Approval shares every claim listed above");
  expect(consent).toContain("Claims become non-exchangeable at expiry.");
  expect(consent).toMatch(
    /Physical encrypted-row deletion is\s+bounded, traffic-driven cleanup and can occur later\./,
  );
});

it("presents Triad rather than a GitHub-only broker", async () => {
  const landing = await readFile("src/pages/index.astro", "utf8");

  expect(landing).not.toContain("GitHub broker");
  expect(landing).toContain("GOOGLE");
  expect(landing).toContain("GITHUB");
  expect(landing).toContain("TWITTER");
  expect(landing).toContain("IDENTITY,");
  expect(landing).toContain("THAT WORKS.");
  expect(landing).not.toContain("Broker upstream");
  expect(landing).not.toContain("NO KEYBOARD?");
  expect(landing).not.toContain("github:107691503");
  expect(landing).toContain("pid_twitter_5a8f");
});

it("states the identity-only privacy default and optional claim contract", async () => {
  const landing = await readFile("src/pages/index.astro", "utf8");

  expect(landing).toContain("ASK FOR LESS.");
  expect(landing).toContain("REVEAL LESS.");
  expect(landing).toContain("IDENTITY ONLY");
  expect(landing).toContain(
    "No raw provider ID, email, handle, name, avatar, or provider access token.",
  );
  expect(landing).toContain("email + email_verified");
  expect(landing).toContain("preferred_username");
  expect(landing).toContain("<dt>name</dt><dd>name</dd>");
  expect(landing).toContain("<dt>avatar</dt><dd>picture</dd>");
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
  expect(demo).toContain('<select id="demo-provider"');
  expect(demo).toContain('name="demo-scope"');
  expect(demo).toContain('value="email"');
  expect(demo).toContain('value="handle"');
  expect(demo).toContain('value="name"');
  expect(demo).toContain('value="avatar"');
  expect(demo).toContain("provider: selectedProvider.id");
  expect(demo).toContain("scope: requestedScope");
  expect(demo).not.toContain('provider: "github"');
});

it("locks the shared provider request while either demo flow is active", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");

  expect(demo).toContain('let activeFlow: "browser" | "device" | null = null;');
  expect(demo).toMatch(/if \(!beginFlow\("browser"\)\)\s*\{\s*return;\s*\}/);
  expect(demo).toMatch(/if \(!beginFlow\("device"\)\)\s*\{\s*return;\s*\}/);
  expect(demo).toContain("providerSelect.disabled = activeFlow !== null;");
  expect(demo).toContain("scopeFieldset.disabled = activeFlow !== null;");
  expect(demo).toContain("browserStart.disabled = activeFlow !== null || !selectedProvider;");
  expect(demo).toContain("deviceStart.disabled = activeFlow !== null || !selectedProvider;");
  expect(demo.match(/finishFlow\("device"\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
});

it("resets stale demo state after persisted pageshow without resuming a grant", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");
  const reset = demo.slice(
    demo.indexOf("function resetRestoredPage"),
    demo.indexOf('providerSelect.addEventListener("change"'),
  );

  expect(demo).toContain('window.addEventListener("pageshow", (event) => {');
  expect(demo).toMatch(/if \(!event\.persisted\)\s*\{\s*return;\s*\}/);
  expect(demo).toContain("resetRestoredPage();");
  expect(reset).toContain("stopDeviceFlow();");
  expect(reset).toContain("activeFlow = null;");
  expect(reset).toContain('activeDeviceCode = "";');
  expect(reset).toContain('tokenEndpoint = "";');
  expect(reset).toContain("expiresAt = 0;");
  expect(reset).toContain("deviceController = new AbortController();");
  expect(reset).toContain("clearDevicePresentation();");
  expect(reset).toContain('sessionStorage.removeItem("triad_demo_state")');
  expect(reset).toContain('sessionStorage.removeItem("triad_demo_verifier")');
  expect(reset).toContain('deviceStart.textContent = "START DEVICE FLOW";');
  expect(reset).toContain("updateRequestControls(false);");
  expect(reset).toContain("Start a new flow.");
  expect(reset).not.toContain("schedulePoll");
  expect(reset).not.toContain("pollDevice");
});

it("offers keyboard-accessible provider retries on demo and account errors", async () => {
  const [demo, account, css] = await Promise.all([
    readFile("src/pages/demo/index.astro", "utf8"),
    readFile("src/pages/me.astro", "utf8"),
    readFile("src/styles/global.css", "utf8"),
  ]);

  expect(demo).toContain('id="provider-retry"');
  expect(demo).toContain("providerRetry.hidden = false");
  expect(demo).toContain('providerRetry.addEventListener("click"');
  expect(account).toContain('id="account-provider-retry"');
  expect(account).toContain("providerRetry.hidden = false");
  expect(account).toContain('providerRetry.addEventListener("click"');
  expect(css).toMatch(/\.control-feedback\s*\{[^}]*display: flex;[^}]*align-items: center;/s);
});

it("populates account sign-in actions from enabled providers", async () => {
  const account = await readFile("src/pages/me.astro", "utf8");

  expect(account).toContain("fetchProviderCapabilities");
  expect(account).toContain("/session/start/${provider.id}");
  expect(account).toContain(
    'providerActions.textContent = "Sign-in providers could not be loaded."',
  );
  expect(account).not.toContain('href="/session/start/github"');
});

it("restores demo controls without replacing a browser start error", async () => {
  const demo = await readFile("src/pages/demo/index.astro", "utf8");
  const recovery = demo.slice(demo.indexOf("The authorization request could not be started"));
  const finish = demo.slice(
    demo.indexOf("function finishFlow"),
    demo.indexOf("async function loadProviderControls"),
  );

  expect(demo).toContain("function updateRequestControls(updateStatus = true)");
  expect(recovery).toContain('finishFlow("browser")');
  expect(finish).toContain("updateRequestControls(false)");
});

it("renders every mandatory disclosure as a factual ledger row", async () => {
  const [consent, device, controls] = await Promise.all([
    readFile("src/pages/consent.astro", "utf8"),
    readFile("src/pages/device/verify.astro", "utf8"),
    readFile("src/scripts/disclosure-controls.ts", "utf8"),
  ]);

  expect(consent).toContain("body.provider");
  expect(consent).toContain("body.scopes");
  expect(consent).toContain("renderDisclosures");
  expect(consent).toContain('act("approve")');
  expect(consent).toContain('act("deny")');
  expect(device).toContain("body.provider");
  expect(device).toContain("body.scopes");
  expect(device).toContain("renderDisclosures");
  expect(device).toContain('id="device-disclosure" class="device-disclosure" hidden');
  expect(device).toContain("disclosureBox.hidden = false");
  expect(device).not.toContain('value="github"');
  expect(controls).toContain("export function renderDisclosures");
  expect(controls).not.toContain('document.createElement("input")');
  expect(controls).not.toContain("disclosure-switch");
  expect(controls.match(/row\.appendChild\(disclosureText\(disclosure\)\)/g)).toHaveLength(2);
  expect(controls).toContain("Share your email address and its verification status.");
  expect(controls).not.toContain("Never use it as an identity key");
});

it("always clears device transaction disclosure when inspection is reset or rejected", async () => {
  const device = await readFile("src/pages/device/verify.astro", "utf8");
  const reset = device.slice(
    device.indexOf("function resetInspectedRequest"),
    device.indexOf("function format"),
  );

  expect(reset).toContain("disclosures.replaceChildren()");
  expect(reset).toContain("disclosureBox.hidden = true");
  expect(reset).toContain("box.hidden = true");
  expect(device.match(/resetInspectedRequest\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
});

it("renders shared claims without moving focus to successful results", async () => {
  const [demo, callback] = await Promise.all([
    readFile("src/pages/demo/index.astro", "utf8"),
    readFile("src/pages/demo/callback.astro", "utf8"),
  ]);

  expect(demo).toContain("identity.profile");
  expect(callback).toContain("verified.profile");
  expect(`${demo}\n${callback}`).not.toMatch(/profile[\s\S]{0,240}innerHTML/);
  expect(`${demo}\n${callback}`).not.toContain("VERIFIED OPTIONAL CLAIMS");
  expect(`${demo}\n${callback}`).toContain("SHARED CLAIMS");
  expect(demo).not.toContain(
    'document.querySelector<HTMLElement>("#device-result-title")!.focus()',
  );
  expect(callback).not.toContain(
    'document.querySelector<HTMLElement>("#callback-result-title")!.focus()',
  );
});

it("separates callback claims from metadata and supports broker sign out", async () => {
  const [callback, css] = await Promise.all([
    readFile("src/pages/demo/callback.astro", "utf8"),
    readFile("src/styles/global.css", "utf8"),
  ]);

  expect(callback).toContain("CHECKING<br /><span>SIGNED RESULT.</span>");
  expect(callback).toContain('id="callback-followup"');
  expect(callback).toContain('id="callback-logout"');
  expect(callback).toContain('fetch("/api/me")');
  expect(callback).toContain('fetch("/session/logout"');
  expect(callback).toContain("body: new URLSearchParams({ csrf_token: account.csrf_token })");
  expect(callback.indexOf('id="callback-identity"')).toBeLessThan(
    callback.indexOf('id="callback-followup"'),
  );
  expect(css).toMatch(
    /\.verified-claims dt,\s*\.verified-profile dt\s*\{[^}]*color: var\(--signal\)/s,
  );
  expect(css).toMatch(/#callback-title span\s*\{[^}]*white-space: nowrap;/s);
});

it("keeps navigation and copy provider-neutral outside provider context", async () => {
  const files = await Promise.all(applicationSources.map((path) => readFile(path, "utf8")));
  const ui = files.join("\n");

  expect(files[0]).toContain('href="/demo/"');
  expect(files[0]).not.toContain('href="/me/">ME');
  expect(files[0]).toContain('href="/me/">ACCOUNT');
  expect(ui).not.toContain("—");
});

it("uses the coral signal and separates account sign out", async () => {
  const [css, account] = await Promise.all([
    readFile("src/styles/global.css", "utf8"),
    readFile("src/pages/me.astro", "utf8"),
  ]);

  expect(css).toContain("--signal: oklch(0.72 0.19 38);");
  expect(css).toMatch(/\.account-actions\s*\{[^}]*margin-top:/s);
  expect(account).toContain('class="actions account-actions"');
});

it("caps long transaction headings at narrow viewports", async () => {
  const css = await readFile("src/styles/global.css", "utf8");
  const mobile = css.slice(
    css.indexOf("@media (max-width: 760px)"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );

  expect(mobile).toMatch(/#consent-title\s*\{\s*font-size: clamp\(2\.2rem, 11vw, 3\.7rem\);\s*\}/);
  expect(mobile).toMatch(/#callback-title\s*\{\s*font-size: clamp\(2\.8rem, 14vw, 3\.7rem\);\s*\}/);
  expect(mobile).toMatch(/\.device-app\s*\{\s*flex-direction: column;\s*\}/);
});

it("gives header and standalone links a minimum touch size", async () => {
  const css = await readFile("src/styles/global.css", "utf8");

  expect(css).toMatch(
    /\.wordmark,\s*\.site-header nav a,\s*\.text-link\s*\{[^}]*min-width: 2\.75rem;[^}]*min-height: 2\.75rem;/s,
  );
});

it("documents the current multi-provider privacy and token contract", async () => {
  const readme = await readFile("README.md", "utf8");

  expect(readme).toContain("Google, GitHub, and Twitter");
  expect(readme).toContain("opaque provider-global identifier");
  expect(readme).toContain("`email`, `handle`, `name`, and `avatar`");
  expect(readme).toContain("remains encrypted and inaccessible to exchange");
  expect(readme).toContain("ID tokens expire after five minutes");
  expect(readme).not.toContain("formatted as `github:<numeric-id>`");
  expect(readme).not.toContain("does not collect profile data");
  expect(readme).not.toContain("does not persist or emit email");
  expect(readme).not.toContain("ID tokens expire after ten minutes");
  expect(readme).not.toContain("GitHub is the only upstream provider");
  expect(readme).not.toContain("There is no email/profile scope");
  expect(readme).not.toContain("provider_sub` starts with `github:");
});
