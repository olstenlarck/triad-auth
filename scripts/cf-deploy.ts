/**
 * Runs `cf deploy` with the named Worker secrets read from the environment, so every deploy sets
 * them, like the deploy workflows pass them in. A missing secret fails before anything uploads.
 * Usage: node ../../scripts/cf-deploy.ts [SECRET_NAME...] -- [cf deploy options], from the app directory
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const separator = process.argv.indexOf("--");
const names = process.argv.slice(2, separator === -1 ? undefined : separator);
const options = separator === -1 ? [] : process.argv.slice(separator + 1);

const missing = names.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing secrets in the environment: ${missing.join(", ")}`);
  process.exit(1);
}

const args = ["exec", "cf", "deploy", ...options];
const directory = names.length > 0 ? mkdtempSync(join(tmpdir(), "cf-secrets-")) : undefined;

try {
  if (directory) {
    const file = join(directory, "secrets.json");
    const secrets = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", file);
  }

  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
}
