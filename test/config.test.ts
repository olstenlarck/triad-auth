import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

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
  getBuiltinModule(name: "node:path"): { join(...paths: string[]): string; resolve(...paths: string[]): string };
};

const { spawnSync } = process.getBuiltinModule("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { join, resolve } = process.getBuiltinModule("node:path");
const checker = resolve(process.cwd(), "scripts/check-config.mjs");

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

function validAmbientConfig(privateJwk: string): Record<string, string> {
  return {
    GITHUB_CLIENT_ID: "ambient-id",
    GITHUB_CLIENT_SECRET: "ambient-secret",
    SIGNING_PRIVATE_JWK: privateJwk,
    PAIRWISE_SECRET: "a".repeat(32),
  };
}

describe("deployment configuration", () => {
  it("overrides only the local dev issuer while preserving canonical production deployment", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const config = readFileSync("wrangler.toml", "utf8");

    expect(packageJson.scripts.dev).toBe(
      "pnpm build && wrangler dev --var ISSUER:http://localhost:8787",
    );
    expect(packageJson.scripts.deploy).toBe("pnpm build && wrangler deploy");
    expect(config).toContain('ISSUER = "https://triad-auth-broker.equator-owl-studio.workers.dev"');
  });

  it("uses a compatibility date supported by the locked workerd baseline", () => {
    const config = readFileSync("wrangler.toml", "utf8");
    const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
    const compatibilityDate = config.match(/^compatibility_date = "([^"]+)"$/m)?.[1];
    const workerdVersion = lockfile.match(/^  workerd@(\d+\.\d+\.\d+):$/m)?.[1];
    const latestSupportedDate: Record<string, string> = {
      "1.20260702.1": "2026-07-09",
    };

    expect(workerdVersion).toBe("1.20260702.1");
    expect(compatibilityDate).toBeDefined();
    expect(compatibilityDate! <= latestSupportedDate[workerdVersion!]).toBe(true);
  });

  it("reports every missing variable without printing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    try {
      const result = runCheck(directory);

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "Missing required configuration: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SIGNING_PRIVATE_JWK, PAIRWISE_SECRET",
      );
      expect(result.stdout).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads .dev.vars as data without evaluating shell syntax", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const marker = join(directory, "shell-command-ran");
    const privateJwk = await generatePrivateJwk();
    try {
      writeFileSync(join(directory, ".dev.vars"), [
        envLine("GITHUB_CLIENT_ID", '"github-client"'),
        envLine("GITHUB_CLIENT_SECRET", `'$(touch ${marker})'`),
        envLine("SIGNING_PRIVATE_JWK", `'${privateJwk}'`),
        envLine("PAIRWISE_SECRET", `'${"p".repeat(32)}'`),
        "",
      ].join("\n"));

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

  it("rejects invalid signing keys and short pairwise secrets without revealing them", () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    try {
      writeFileSync(join(directory, ".dev.vars"), [
        envLine("GITHUB_CLIENT_ID", "github-client"),
        envLine("GITHUB_CLIENT_SECRET", "github-secret"),
        envLine("SIGNING_PRIVATE_JWK", "'{}'"),
        envLine("PAIRWISE_SECRET", "too-short"),
        "",
      ].join("\n"));

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).toContain("PAIRWISE_SECRET must be at least 32 characters");
      expect(output).not.toContain("github-secret");
      expect(output).not.toContain("too-short");
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
        "Missing required configuration: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SIGNING_PRIVATE_JWK, PAIRWISE_SECRET",
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
      writeFileSync(join(directory, ".dev.vars"), [
        envLine("GITHUB_CLIENT_ID", "file-id"),
        envLine("GITHUB_CLIENT_SECRET", "file-secret"),
        envLine("SIGNING_PRIVATE_JWK", "'{}'"),
        envLine("PAIRWISE_SECRET", "short"),
        "",
      ].join("\n"));

      const result = runCheck(directory, ambient);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).toContain("PAIRWISE_SECRET must be at least 32 characters");
      expect(output).not.toContain("ambient-secret");
      expect(output).not.toContain("file-secret");
      expect(output).not.toContain("short");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not count whitespace padding toward pairwise-secret length", async () => {
    const directory = mkdtempSync(join(tmpdir(), "triad-config-"));
    const privateJwk = await generatePrivateJwk();
    try {
      writeFileSync(join(directory, ".dev.vars"), [
        envLine("GITHUB_CLIENT_ID", "file-id"),
        envLine("GITHUB_CLIENT_SECRET", "file-secret"),
        envLine("SIGNING_PRIVATE_JWK", `'  ${privateJwk}  '`),
        envLine("PAIRWISE_SECRET", `'  ${"p".repeat(28)}  '`),
        "",
      ].join("\n"));

      const result = runCheck(directory);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("PAIRWISE_SECRET must be at least 32 characters");
      expect(output).not.toContain("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
      expect(output).not.toContain("file-secret");
      expect(output).not.toContain("p".repeat(28));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
