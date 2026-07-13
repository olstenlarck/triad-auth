import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vite-plus/test";

declare const process: {
  cwd(): string;
  execPath: string;
  getBuiltinModule(name: "node:child_process"): {
    spawnSync(
      command: string,
      args: string[],
      options: { cwd: string; encoding: "utf8"; env: Record<string, string> },
    ): { status: number | null; stdout: string; stderr: string };
  };
  getBuiltinModule(name: "node:fs"): {
    existsSync(path: string): boolean;
    mkdtempSync(prefix: string): string;
    readFileSync(path: string, encoding: "utf8"): string;
    rmSync(path: string, options: { recursive: true; force: true }): void;
    writeFileSync(path: string, data: string): void;
  };
  getBuiltinModule(name: "node:os"): { tmpdir(): string };
  getBuiltinModule(name: "node:path"): {
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
  };
};

const { spawnSync } = process.getBuiltinModule("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
  process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { join, resolve } = process.getBuiltinModule("node:path");
const checker = resolve(process.cwd(), "scripts/check-config.mjs");

const providerPairs = {
  GOOGLE: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  GITHUB: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  TWITTER: ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"],
} as const;
const compareStrings = (left: string, right: string) => left.localeCompare(right);
const runtimeSecretNames = [
  "SIGNING_PRIVATE_JWK",
  "IDENTIFIER_SECRET",
  "CLAIMS_ENCRYPTION_KEYRING",
  "RATE_LIMIT_SECRET",
] as const;
const secretNames = [...Object.values(providerPairs).flat(), ...runtimeSecretNames].sort(
  compareStrings,
);
const secretNameSet = new Set<string>(secretNames);

function runCheck(cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8", env });
}

function envLine(name: string, value: string): string {
  return `${name}=${value}`;
}

async function generatePrivateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return JSON.stringify(await exportJWK(privateKey));
}

function claimsKeyring(secret = "c".repeat(32), legacy?: string): string {
  return JSON.stringify({
    active: "current",
    keys: { current: secret },
    ...(legacy === undefined ? {} : { legacy }),
  });
}

function validAmbientConfig(privateJwk: string): Record<string, string> {
  return {
    GITHUB_CLIENT_ID: "ambient-id",
    GITHUB_CLIENT_SECRET: "ambient-secret",
    ...requiredValues(privateJwk),
  };
}

function requiredValues(privateJwk: string): Record<string, string> {
  return {
    SIGNING_PRIVATE_JWK: privateJwk,
    IDENTIFIER_SECRET: "i".repeat(32),
    CLAIMS_ENCRYPTION_KEYRING: claimsKeyring(),
    RATE_LIMIT_SECRET: "r".repeat(32),
  };
}

function writeDevVars(directory: string, values: Record<string, string>): void {
  writeFileSync(
    join(directory, ".dev.vars"),
    `${Object.entries(values)
      .map(([name, value]) => envLine(name, `'${value}'`))
      .join("\n")}\n`,
  );
}

describe("deployment configuration", () => {
  it("overrides only the local dev issuer while preserving canonical production deployment", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const config = readFileSync("wrangler.toml", "utf8");
    const astroConfig = readFileSync("astro.config.mjs", "utf8");
    const worker = readFileSync("src/index.ts", "utf8");
    const pages = [
      "src/pages/index.astro",
      "src/pages/me.astro",
      "src/pages/consent.astro",
      "src/pages/device/verify.astro",
      "src/pages/demo/index.astro",
      "src/pages/demo/callback.astro",
    ].map((path) => readFileSync(path, "utf8"));

    expect(packageJson.dependencies).toHaveProperty("@astrojs/cloudflare");
    expect(packageJson.scripts.build).toBe(
      "vp exec astro build && node scripts/generate-csp-hashes.mjs",
    );
    expect(packageJson.scripts.deploy).toBe("vp run build && vp exec wrangler deploy");
    expect(packageJson.scripts.dev).toBe("CLOUDFLARE_ENV=local vp exec astro dev");
    expect(packageJson.scripts.preview).toBe("vp run build && vp exec astro preview");
    expect(astroConfig).toContain('from "@astrojs/cloudflare"');
    expect(astroConfig).toContain("adapter: cloudflare(");
    expect(astroConfig).toContain('output: "server"');
    expect(worker).toContain('import("@astrojs/cloudflare/handler")');
    expect(worker).toContain('c.req.path.startsWith("/__astro_")');
    expect(worker).toContain(
      "return handle(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext)",
    );
    expect(worker).toContain("const asset = await c.env.ASSETS.fetch(c.req.raw)");
    expect(worker).toContain("return new Response(asset.body, asset)");
    expect(worker).not.toContain('from "astro/hono"');
    expect(pages.every((page) => page.includes("export const prerender = true"))).toBe(true);
    const viteConfig = readFileSync("vite.config.ts", "utf8");

    expect(viteConfig).toContain("vp exec astro build");
    expect(viteConfig).not.toContain("scripts: true");
    expect(viteConfig).toContain('"**/*.{ts,tsx,js,jsx,mjs,cjs,astro,css,toml,json,yaml}"');
    expect(config).toContain('ISSUER = "https://triad.wgw.lol"');
    expect(config).toContain(
      'PROVIDER_CALLBACK_ORIGIN = "https://triad-auth-broker.equator-owl-studio.workers.dev"',
    );
    expect(config).toContain('[env.local.vars]\nISSUER = "http://localhost:4321"');
  });

  it("uses a compatibility date supported by the locked workerd baseline", () => {
    const config = readFileSync("wrangler.toml", "utf8");
    const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
    const compatibilityDate = config.match(/^compatibility_date = "([^"]+)"$/m)?.[1];
    const workerdVersion = lockfile.match(/^  workerd@(\d+\.\d+\.\d+):$/m)?.[1];
    const latestSupportedDate: Record<string, string> = {
      "1.20260702.1": "2026-07-09",
      "1.20260708.1": "2026-07-09",
    };

    expect(workerdVersion).toBe("1.20260708.1");
    expect(compatibilityDate).toBeDefined();
    expect(compatibilityDate! <= latestSupportedDate[workerdVersion!]).toBe(true);
  });

  it("reports every missing variable without printing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    try {
      const result = runCheck(directory);

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "Missing required configuration: SIGNING_PRIVATE_JWK, IDENTIFIER_SECRET, CLAIMS_ENCRYPTION_KEYRING, RATE_LIMIT_SECRET\nAt least one complete provider credential pair is required",
      );
      expect(result.stdout).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts any one complete provider credential pair", async () => {
    const privateJwk = await generatePrivateJwk();
    for (const pair of Object.values(providerPairs)) {
      const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
      try {
        writeDevVars(directory, {
          ...requiredValues(privateJwk),
          [pair[0]]: `${pair[0]}-value`,
          [pair[1]]: `${pair[1]}-value`,
        });

        const result = runCheck(directory);

        expect(result.status, pair[0]).toBe(0);
        expect(result.stdout.trim()).toBe("Configuration valid");
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(`${pair[0]}-value`);
        expect(result.stdout).not.toContain(`${pair[1]}-value`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects signing configuration without a complete provider pair", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const privateJwk = await generatePrivateJwk();
    const required = requiredValues(privateJwk);
    try {
      writeDevVars(directory, required);

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "At least one complete provider credential pair is required",
      );
      expect(result.stdout).toBe("");
      for (const value of Object.values(required)) {
        expect(output).not.toContain(value);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects every half-configured provider pair without exposing values", async () => {
    const privateJwk = await generatePrivateJwk();
    const cases = [
      {
        configured: "GOOGLE_CLIENT_ID",
        missing: "GOOGLE_CLIENT_SECRET",
        fallback: providerPairs.GITHUB,
      },
      {
        configured: "GOOGLE_CLIENT_SECRET",
        missing: "GOOGLE_CLIENT_ID",
        fallback: providerPairs.GITHUB,
      },
      {
        configured: "GITHUB_CLIENT_ID",
        missing: "GITHUB_CLIENT_SECRET",
        fallback: providerPairs.GOOGLE,
      },
      {
        configured: "GITHUB_CLIENT_SECRET",
        missing: "GITHUB_CLIENT_ID",
        fallback: providerPairs.GOOGLE,
      },
      {
        configured: "TWITTER_CLIENT_ID",
        missing: "TWITTER_CLIENT_SECRET",
        fallback: providerPairs.GITHUB,
      },
      {
        configured: "TWITTER_CLIENT_SECRET",
        missing: "TWITTER_CLIENT_ID",
        fallback: providerPairs.GITHUB,
      },
    ] as const;

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
      const configuredValue = `${testCase.configured}-sensitive-value`;
      try {
        writeDevVars(directory, {
          ...requiredValues(privateJwk),
          [testCase.fallback[0]]: "fallback-id",
          [testCase.fallback[1]]: "fallback-secret",
          [testCase.configured]: configuredValue,
        });

        const result = runCheck(directory);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status, testCase.configured).toBe(1);
        expect(result.stderr).toContain(`Incomplete provider configuration: ${testCase.missing}`);
        expect(result.stdout).toBe("");
        expect(output).not.toContain(configuredValue);
        expect(output).not.toContain("fallback-id");
        expect(output).not.toContain("fallback-secret");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps the exact ten secret names aligned across Env, checker, example, and Wrangler", () => {
    const types = readFileSync("src/types.ts", "utf8");
    const checkerSource = readFileSync("scripts/check-config.mjs", "utf8");
    const example = readFileSync(".dev.vars.example", "utf8");
    const wrangler = readFileSync("wrangler.toml", "utf8");
    const envFields = [...types.matchAll(/^  ([A-Z][A-Z0-9_]*)(\?)?: string;$/gm)]
      .filter((match) => secretNameSet.has(match[1]))
      .map((match) => ({ name: match[1], optional: match[2] === "?" }));
    const checkerNames = [...checkerSource.matchAll(/"([A-Z][A-Z0-9_]+)"/g)]
      .map((match) => match[1])
      .filter((name) => secretNameSet.has(name));
    const exampleNames = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    const wranglerNames = [
      ...wrangler
        .slice(wrangler.indexOf("# Add required secrets"))
        .matchAll(/\b[A-Z][A-Z0-9_]+\b/g),
    ]
      .map((match) => match[0])
      .filter((name) => name !== "NAME");

    expect(envFields.map(({ name }) => name).sort(compareStrings)).toEqual(secretNames);
    expect(
      envFields
        .filter(({ optional }) => optional)
        .map(({ name }) => name)
        .sort(compareStrings),
    ).toEqual(Object.values(providerPairs).flat().sort(compareStrings));
    expect([...new Set(checkerNames)].sort(compareStrings)).toEqual(secretNames);
    expect(exampleNames.sort(compareStrings)).toEqual(secretNames);
    expect(wranglerNames.sort(compareStrings)).toEqual(secretNames);
  });

  it("documents exact provider links and local and production callbacks", () => {
    const readme = readFileSync("README.md", "utf8");
    const setupCallbacks = [
      ...readme.matchAll(
        /^- (?:Local|Production)(?: callback)?: `([^`]+\/callback\/(?:google|github|twitter))`$/gm,
      ),
    ].map((match) => match[1]);
    const callbackOrigin = "https://triad-auth-broker.equator-owl-studio.workers.dev";

    expect(readme).toContain("https://console.cloud.google.com/auth/clients");
    expect(readme).toContain("https://console.cloud.google.com/auth/overview");
    expect(readme).toContain("https://github.com/settings/applications/new");
    expect(readme).toContain("https://developer.x.com/en/portal/dashboard");
    expect(readme).toContain("https://developer.x.com/en/portal/projects-and-apps");
    expect(setupCallbacks).toEqual([
      "http://localhost:4321/callback/google",
      `${callbackOrigin}/callback/google`,
      "http://localhost:4321/callback/github",
      `${callbackOrigin}/callback/github`,
      "http://localhost:4321/callback/twitter",
      `${callbackOrigin}/callback/twitter`,
    ]);
    for (const provider of ["google", "github", "twitter"]) {
      expect(readme).toContain(`${callbackOrigin}/callback/${provider}`);
    }
  });

  it("documents the exact capability matrix, mandatory scopes, and Twitter upstream scopes", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toMatch(/\| Google\s+\| Yes\s+\| No\s+\| Yes\s+\| Yes\s+\|/);
    expect(readme).toMatch(/\| GitHub\s+\| Yes\s+\| Yes\s+\| Yes\s+\| Yes\s+\|/);
    expect(readme).toMatch(/\| Twitter\s+\| No\s+\| Yes\s+\| Yes\s+\| Yes\s+\|/);
    expect(readme).toContain("every requested scope is mandatory");
    expect(readme).toContain("`avatar` request scope maps to the standard `picture` claim");
    expect(readme).toContain("`pairwise` is the standard OpenID Connect subject type");
    expect(readme).toContain(
      "Triad requests only `tweet.read users.read`; it does not request offline access.",
    );
    expect(readme).toContain("encrypted");
    expect(readme).toContain("opaque provider-global identifier");
    expect(readme).toContain("five minutes");
    expect(readme).toContain("X branding");
  });

  it("documents logical claim expiry separately from traffic-driven physical cleanup", () => {
    const documents = [
      readFileSync("README.md", "utf8"),
      readFileSync("docs/superpowers/specs/2026-07-10-multi-provider-identity-design.md", "utf8"),
    ];

    for (const document of documents) {
      expect(document).toContain(
        "Abandoned profile ciphertext is exchangeable only until the authorization code's two-minute TTL or the device grant's ten-minute TTL.",
      );
      expect(document).toContain(
        "After expiry it remains encrypted and inaccessible to exchange, even if its row is still physically present.",
      );
      expect(document).toContain(
        "Bounded, sampled, traffic-driven cleanup physically deletes expired rows when later requests trigger it, so physical retention can exceed the protocol TTL when no later traffic arrives.",
      );
      expect(document).not.toContain("retained for at most two minutes");
      expect(document).not.toContain("lives for at most two minutes");
    }
  });

  it("documents migration before deployment and exact post-deploy smoke checks", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain(
      "vp run check\nvp run test\nvp run build\nvp run db:remote\nvp run deploy",
    );
    expect(readme).toContain('curl --fail "$ISSUER/api/providers"');
    expect(readme).toContain('curl --fail "$ISSUER/.well-known/openid-configuration"');
    expect(readme).toContain("Supported callback paths on this issuer are:");
    expect(readme).toContain(
      "`/api/providers` is authoritative for which providers are currently enabled",
    );
  });

  it("documents the first secret-separation deployment without rotating identity", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain(
      "Set `IDENTIFIER_SECRET` to the exact current `PAIRWISE_SECRET` value.",
    );
    expect(readme).toContain(
      "For the first deployment, set `legacy` inside `CLAIMS_ENCRYPTION_KEYRING` to that same current `PAIRWISE_SECRET` value.",
    );
    expect(readme).toContain(
      "Generate independent new values for `RATE_LIMIT_SECRET` and the active claims key.",
    );
  });

  it("loads .dev.vars as data without evaluating shell syntax", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const marker = join(directory, "shell-command-ran");
    const privateJwk = await generatePrivateJwk();
    try {
      writeFileSync(
        join(directory, ".dev.vars"),
        [
          envLine("GITHUB_CLIENT_ID", '"github-client"'),
          envLine("GITHUB_CLIENT_SECRET", `'$(touch ${marker})'`),
          envLine("SIGNING_PRIVATE_JWK", `'${privateJwk}'`),
          envLine("IDENTIFIER_SECRET", `'${"i".repeat(32)}'`),
          envLine("CLAIMS_ENCRYPTION_KEYRING", `'${claimsKeyring()}'`),
          envLine("RATE_LIMIT_SECRET", `'${"r".repeat(32)}'`),
          "",
        ].join("\n"),
      );

      const result = runCheck(directory);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("Configuration valid");
      expect(result.stderr).toBe("");
      expect(existsSync(marker)).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain("github-client");
      expect(`${result.stdout}${result.stderr}`).not.toContain("touch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid signing keys and short independent secrets without revealing them", () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    try {
      writeFileSync(
        join(directory, ".dev.vars"),
        [
          envLine("GITHUB_CLIENT_ID", "github-client"),
          envLine("GITHUB_CLIENT_SECRET", "github-secret"),
          envLine("SIGNING_PRIVATE_JWK", "'{}'"),
          envLine("IDENTIFIER_SECRET", "identifier-too-short"),
          envLine("CLAIMS_ENCRYPTION_KEYRING", `'${claimsKeyring()}'`),
          envLine("RATE_LIMIT_SECRET", "rate-limit-too-short"),
          "",
        ].join("\n"),
      );

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).toContain("IDENTIFIER_SECRET must be at least 32 characters");
      expect(output).toContain("RATE_LIMIT_SECRET must be at least 32 characters");
      expect(output).not.toContain("github-secret");
      expect(output).not.toContain("identifier-too-short");
      expect(output).not.toContain("rate-limit-too-short");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["non-JSON", "not-json"],
    [
      "unsafe active key ID",
      JSON.stringify({ active: "invalid.key", keys: { "invalid.key": "c".repeat(32) } }),
    ],
    [
      "missing active key",
      JSON.stringify({ active: "current", keys: { previous: "p".repeat(32) } }),
    ],
    [
      "more than two named keys",
      JSON.stringify({
        active: "current",
        keys: {
          current: "c".repeat(32),
          previous: "p".repeat(32),
          next: "n".repeat(32),
        },
      }),
    ],
    ["short named key", claimsKeyring("short")],
    ["short legacy key", claimsKeyring("c".repeat(32), "short")],
  ])("rejects a claims keyring with %s", async (_description, invalidKeyring) => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    try {
      writeDevVars(directory, {
        ...requiredValues(await generatePrivateJwk()),
        CLAIMS_ENCRYPTION_KEYRING: invalidKeyring,
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      });

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("CLAIMS_ENCRYPTION_KEYRING must be a valid claims keyring");
      expect(output).not.toContain(invalidKeyring);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not use ambient values for variables missing from .dev.vars", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const ambient = validAmbientConfig(await generatePrivateJwk());
    try {
      writeFileSync(join(directory, ".dev.vars"), "# intentionally empty\n");

      const result = runCheck(directory, ambient);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "Missing required configuration: SIGNING_PRIVATE_JWK, IDENTIFIER_SECRET, CLAIMS_ENCRYPTION_KEYRING, RATE_LIMIT_SECRET\nAt least one complete provider credential pair is required",
      );
      expect(output).not.toContain("ambient-id");
      expect(output).not.toContain("ambient-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let ambient values replace invalid .dev.vars values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const ambient = validAmbientConfig(await generatePrivateJwk());
    try {
      writeFileSync(
        join(directory, ".dev.vars"),
        [
          envLine("GITHUB_CLIENT_ID", "file-id"),
          envLine("GITHUB_CLIENT_SECRET", "file-secret"),
          envLine("SIGNING_PRIVATE_JWK", "'{}'"),
          envLine("IDENTIFIER_SECRET", "identifier-short"),
          envLine("CLAIMS_ENCRYPTION_KEYRING", "invalid-keyring"),
          envLine("RATE_LIMIT_SECRET", "rate-short"),
          "",
        ].join("\n"),
      );

      const result = runCheck(directory, ambient);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).toContain("IDENTIFIER_SECRET must be at least 32 characters");
      expect(output).toContain("CLAIMS_ENCRYPTION_KEYRING must be a valid claims keyring");
      expect(output).toContain("RATE_LIMIT_SECRET must be at least 32 characters");
      expect(output).not.toContain("ambient-secret");
      expect(output).not.toContain("file-secret");
      expect(output).not.toContain("identifier-short");
      expect(output).not.toContain("invalid-keyring");
      expect(output).not.toContain("rate-short");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not count whitespace padding toward independent-secret lengths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const privateJwk = await generatePrivateJwk();
    try {
      writeFileSync(
        join(directory, ".dev.vars"),
        [
          envLine("GITHUB_CLIENT_ID", "file-id"),
          envLine("GITHUB_CLIENT_SECRET", "file-secret"),
          envLine("SIGNING_PRIVATE_JWK", `'  ${privateJwk}  '`),
          envLine("IDENTIFIER_SECRET", `'  ${"i".repeat(28)}  '`),
          envLine("CLAIMS_ENCRYPTION_KEYRING", `'  ${claimsKeyring()}  '`),
          envLine("RATE_LIMIT_SECRET", `'  ${"r".repeat(28)}  '`),
          "",
        ].join("\n"),
      );

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("IDENTIFIER_SECRET must be at least 32 characters");
      expect(output).toContain("RATE_LIMIT_SECRET must be at least 32 characters");
      expect(output).not.toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).not.toContain("CLAIMS_ENCRYPTION_KEYRING must be a valid claims keyring");
      expect(output).not.toContain("file-secret");
      expect(output).not.toContain("i".repeat(28));
      expect(output).not.toContain("r".repeat(28));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
