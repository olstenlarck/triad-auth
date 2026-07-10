import { expect, it } from "vitest";

declare const process: {
  getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
};

const { readFileSync } = process.getBuiltinModule("node:fs");
const readFile = async (path: string, _encoding: "utf8") => readFileSync(path, "utf8");

it("builds both demo entry points", async () => {
  await expect(readFile("dist/demo/index.html", "utf8")).resolves.toContain("TRY THE BROKER");
  await expect(readFile("dist/demo/callback/index.html", "utf8")).resolves.toContain("VERIFYING IDENTITY");
});

it("seeds only the exact local downstream demo client", async () => {
  const migration = await readFile("migrations/0001_init.sql", "utf8");

  expect(migration).toContain(
    "VALUES ('triad-demo', 'Triad demo', '[\"http://localhost:8787/demo/callback/\"]', '[\"github\"]', unixepoch());",
  );
  expect(migration).not.toContain("'local-dev'");
  expect(migration).not.toContain("localhost:3000");
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
  expect(`${demo}\n${callback}`).toContain("globally correlatable");
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
  expect(consent).toContain("globally correlatable");
  expect(device).toContain('type="hidden" name="provider" value="github"');
  expect(device).toContain('type="hidden" name="csrf_token"');
  expect(device).not.toContain('type="radio"');
  expect(device).not.toContain('value="google"');
  expect(device).not.toContain('value="x"');
});

it("keeps all navigation and product copy GitHub-only", async () => {
  const files = await Promise.all([
    "src/components/Shell.astro",
    "src/pages/index.astro",
    "src/pages/me.astro",
    "src/pages/consent.astro",
    "src/pages/device/verify.astro",
    "src/pages/demo/index.astro",
    "src/pages/demo/callback.astro",
  ].map((path) => readFile(path, "utf8")));
  const ui = files.join("\n");

  expect(files[0]).toContain('href="/demo/"');
  expect(files[1]).toContain("globally correlatable");
  expect(ui).not.toMatch(/Google|Twitter|GOOGLE|TWITTER|session\/start\/x|>X<|value="x"/);
  expect(ui).not.toContain("—");
});
