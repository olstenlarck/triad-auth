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
    rmSync(path: string, options: { recursive: true; force: true }): void;
    writeFileSync(path: string, data: string): void;
  };
  getBuiltinModule(name: "node:os"): { tmpdir(): string };
  getBuiltinModule(name: "node:path"): { join(...paths: string[]): string; resolve(...paths: string[]): string };
};

const { spawnSync } = process.getBuiltinModule("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { join, resolve } = process.getBuiltinModule("node:path");
const checker = resolve(process.cwd(), "scripts/check-config.mjs");

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8", env: {} });
}

function envLine(name: string, value: string): string {
  return `${name}=${value}`;
}

describe("deployment configuration", () => {
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
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = JSON.stringify(await exportJWK(privateKey));
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
});
