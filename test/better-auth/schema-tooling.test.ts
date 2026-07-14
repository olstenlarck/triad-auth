// @ts-expect-error Node types are intentionally absent from the Worker project.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { authSchemaDatabase } from "../../scripts/auth-schema-database";

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const schemaIntrospectionQuery =
  'select "name", "type", "sql" from "sqlite_master" where "type" in (?, ?) and "name" not like ? and "name" not like ? and "name" != ? and "name" != ?';
const schemaIntrospectionParameters = [
  "table",
  "view",
  "sqlite_%",
  "_cf_%",
  "kysely_migration",
  "kysely_migration_lock",
];
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

  it("returns an empty schema for Better Auth's exact D1 introspection query", async () => {
    const result = await authSchemaDatabase
      .prepare(schemaIntrospectionQuery)
      .bind(...schemaIntrospectionParameters)
      .all();

    expect(result).toMatchObject({
      success: true,
      results: [],
      meta: {
        changes: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: 0,
      },
    });
  });

  it("rejects arbitrary application SQL", () => {
    expect(() => authSchemaDatabase.prepare('select * from "user"')).toThrow(
      "schema introspection",
    );
  });

  it("rejects introspection execution with unexpected bindings", async () => {
    const statement = authSchemaDatabase.prepare(schemaIntrospectionQuery).bind("table");

    await expect(statement.all()).rejects.toThrow("schema introspection");
  });

  it("throws from every unsupported query method", () => {
    const statement = authSchemaDatabase
      .prepare(schemaIntrospectionQuery)
      .bind(...schemaIntrospectionParameters);

    expect(() => authSchemaDatabase.batch([])).toThrow("SQL generation only");
    expect(() => authSchemaDatabase.exec("select 1")).toThrow("SQL generation only");
    expect(() => statement.first()).toThrow("SQL generation only");
    expect(() => statement.raw()).toThrow("SQL generation only");
    expect(() => statement.run()).toThrow("SQL generation only");
  });

  it("keeps the schema-only database out of every runtime module", () => {
    const runtimeModules = [
      "src/index.ts",
      "src/better-auth/auth.ts",
      "src/better-auth/configuration.ts",
    ];
    const applicationTypeScriptPaths = (readdirSync("src", { recursive: true }) as string[])
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `src/${path}`);
    const schemaDatabaseConsumers = applicationTypeScriptPaths.filter((path) =>
      readSource(path).includes("auth-schema-database"),
    );

    for (const path of runtimeModules) {
      expect(readSource(path)).not.toContain("auth-schema-database");
    }
    expect(schemaDatabaseConsumers).toEqual(["src/better-auth/schema.ts"]);
  });
});
