// @ts-expect-error Node types are intentionally absent from the Worker project.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const wranglerSource = readSource("wrangler.toml");
const schemaSource = readSource("src/better-auth/schema.ts");
const schemaDatabaseSource = readSource("scripts/auth-schema-database.ts");

describe("Better Auth schema tooling", () => {
  it("configures only the isolated placeholder D1 binding", () => {
    const bindingBlocks = wranglerSource.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|$)/g) ?? [];

    expect(bindingBlocks).toHaveLength(1);
    expect(bindingBlocks[0]).toContain('binding = "DB"');
    expect(bindingBlocks[0]).toContain('database_name = "triad-better-auth"');
    expect(bindingBlocks[0]).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(bindingBlocks[0]).toContain('migrations_dir = "migrations"');
    expect(wranglerSource.match(/database_id\s*=/g)).toHaveLength(1);
  });

  it("exposes generation and local-only migration commands", () => {
    expect(packageJson.scripts["auth:schema"]).toBe(
      "vp exec auth generate --config src/better-auth/schema.ts --output migrations/0001_better-auth.sql --yes",
    );
    expect(packageJson.scripts["db:migrate:local"]).toBe(
      "vp exec wrangler d1 migrations apply triad-better-auth --local",
    );
    expect(packageJson.scripts).not.toHaveProperty("db:migrate:remote");
  });

  it("does not add an adapter, emulator, SQLite driver, or legacy resource name", () => {
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ].join("\n");
    const toolingSource = [
      dependencyNames,
      JSON.stringify(packageJson.scripts),
      wranglerSource,
      schemaSource,
      schemaDatabaseSource,
    ].join("\n");

    expect(toolingSource).not.toMatch(
      /drizzle|miniflare|better-sqlite3|bun:sqlite|node:sqlite|sqlite3/i,
    );
    expect(toolingSource).not.toMatch(/triad-auth-broker|["']triad-auth["']/);
  });

  it("builds the schema auth instance through the canonical configuration", () => {
    const configurationCall = schemaSource.match(
      /const\s+(\w+)\s*=\s*createTriadConfiguration\(schemaEnv\);/,
    );

    expect(schemaSource).toContain('import { createTriadAuth } from "./auth";');
    expect(schemaSource).toContain('import { createTriadConfiguration } from "./configuration";');
    expect(configurationCall).not.toBeNull();
    expect(schemaSource).toContain(
      `export const auth = createTriadAuth(schemaEnv, ${configurationCall?.[1]});`,
    );
    expect(schemaSource).not.toMatch(/\bbetterAuth\s*\(/);
  });
});
