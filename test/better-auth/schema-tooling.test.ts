// @ts-expect-error Node types are intentionally absent from the Worker project.
import { existsSync, readFileSync, readdirSync } from "node:fs";
// @ts-expect-error Node types are intentionally absent from the Worker project.
import { dirname, extname, relative, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { authSchemaDatabase } from "../../scripts/auth-schema-database";

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

type DirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
};

const runtimeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const repositoryRoot = resolve(".");

function collectRuntimeSourcePaths(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }) as DirectoryEntry[];

  return entries
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return collectRuntimeSourcePaths(path);
      }

      return runtimeExtensions.has(extname(path)) ? [path] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function importSpecifiers(source: string): string[] {
  const importPattern =
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  return Array.from(source.matchAll(importPattern), (match) => match[1] ?? match[2]);
}

function modulePath(path: string): string {
  const extension = extname(path);

  return runtimeExtensions.has(extension) ? path.slice(0, -extension.length) : path;
}

function normalizeModuleId(path: string): string {
  return modulePath(path.replaceAll("\\", "/")).replace(/^\.?\//, "");
}

function repositoryModuleId(path: string): string {
  return normalizeModuleId(relative(repositoryRoot, resolve(path)));
}

function resolvesToModule(importerPath: string, specifier: string, targetPath: string): boolean {
  const targetId = repositoryModuleId(targetPath);
  if (specifier.startsWith(".")) {
    return repositoryModuleId(resolve(dirname(importerPath), specifier)) === targetId;
  }

  const specifierId = normalizeModuleId(specifier);

  return specifierId === targetId || specifierId.endsWith(`/${targetId}`);
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
const unsupportedIntrospectionError = "no such table: oauthResource";
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const wranglerSource = readSource("wrangler.toml");
const schemaSource = readSource("src/better-auth/schema.ts");
const schemaDatabaseSource = readSource("scripts/auth-schema-database.ts");
const migrationFiles = readdirSync("migrations")
  .filter((path: string) => path.endsWith(".sql"))
  .sort();
const baselineMigration = readSource("migrations/0001_better-auth.sql");
const profileDataMigration = readSource("migrations/0002-profile-data.sql");

describe("Better Auth schema tooling", () => {
  it("keeps the baseline migration immutable and applies profile changes forward", () => {
    expect(migrationFiles).toEqual(["0001_better-auth.sql", "0002-profile-data.sql"]);
    expect(baselineMigration).toContain('"profileEmail" text');
    expect(baselineMigration).not.toContain('"profileData" text');
    expect(baselineMigration).toContain('create table "deviceCode"');
    expect(profileDataMigration).toContain('create table "user_new"');
    expect(profileDataMigration).toContain('drop table "user"');
    expect(profileDataMigration).toContain('alter table "user_new" rename to "user"');
    expect(profileDataMigration).toContain('"profileData" text');
    expect(profileDataMigration).toContain('"name" text not null');
    expect(profileDataMigration).toContain('"email" text not null unique');
    expect(profileDataMigration).toContain('"emailVerified" integer not null');
    expect(profileDataMigration).toContain('"image" text');
    expect(profileDataMigration).toContain("\"id\" || '@identity.invalid'");
    expect(profileDataMigration).not.toContain('"profileEmail"');
    expect(profileDataMigration).not.toContain('"profileEmailVerified"');
    expect(profileDataMigration).not.toContain('"profileHandle"');
    expect(profileDataMigration).not.toContain('"profileDisplayName"');
    expect(profileDataMigration).not.toContain('"profileAvatar"');
    expect(profileDataMigration).toContain('create table "rateLimit"');
    expect(baselineMigration).toContain(
      'create index "deviceCode_userCode_userId_idx" on "deviceCode" ("userCode", "userId")',
    );
  });

  it("configures only the isolated production D1 binding", () => {
    const bindingBlocks = wranglerSource.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|$)/g) ?? [];

    expect(bindingBlocks).toHaveLength(1);
    expect(bindingBlocks[0]).toContain('binding = "DB"');
    expect(bindingBlocks[0]).toContain('database_name = "triad-better-auth"');
    expect(bindingBlocks[0]).toContain('database_id = "399fd461-e15b-4175-8424-e268ad1dad89"');
    expect(bindingBlocks[0]).toContain('migrations_dir = "migrations"');
    expect(wranglerSource).toContain("[[env.staging.d1_databases]]");
    expect(wranglerSource).toContain('database_name = "triad-better-auth-staging"');
    expect(wranglerSource.match(/database_id\s*=/g)).toHaveLength(2);
  });

  it("exposes generation and local-only migration commands", () => {
    expect(packageJson.scripts["auth:schema"]).toBe(
      "vp exec auth generate --config src/better-auth/schema.ts --output /tmp/triad-better-auth-schema.sql --yes",
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
    expect(toolingSource).not.toMatch(/["']triad-auth["']/);
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
      unsupportedIntrospectionError,
    );
  });

  it("rejects introspection execution with unexpected bindings", async () => {
    const statement = authSchemaDatabase.prepare(schemaIntrospectionQuery).bind("table");

    await expect(statement.all()).rejects.toThrow(unsupportedIntrospectionError);
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

  it.each([
    ["relative schema", "../better-auth/schema", "src/better-auth/schema.ts"],
    ["relative database", "../../scripts/auth-schema-database", "scripts/auth-schema-database.ts"],
    ["absolute schema", "/src/better-auth/schema.ts", "src/better-auth/schema.ts"],
    ["alias schema", "@triad/src/better-auth/schema", "src/better-auth/schema.ts"],
    ["alias database", "@triad/scripts/auth-schema-database.ts", "scripts/auth-schema-database.ts"],
  ])("recognizes a %s import of a protected module", (_name, specifier, targetPath) => {
    expect(resolvesToModule(resolve("src/pages/index.astro"), specifier, resolve(targetPath))).toBe(
      true,
    );
  });

  it("does not treat a partial module name as an alias suffix", () => {
    expect(
      resolvesToModule(
        resolve("src/pages/index.astro"),
        "schema",
        resolve("src/better-auth/schema.ts"),
      ),
    ).toBe(false);
  });

  it("keeps the schema-only database out of every runtime module", () => {
    const schemaEntryPath = resolve("src/better-auth/schema.ts");
    const schemaDatabasePath = resolve("scripts/auth-schema-database.ts");
    const violations = collectRuntimeSourcePaths("src").flatMap((path) => {
      if (path === schemaEntryPath) {
        return [];
      }

      return importSpecifiers(readSource(path))
        .filter(
          (specifier) =>
            resolvesToModule(path, specifier, schemaEntryPath) ||
            resolvesToModule(path, specifier, schemaDatabasePath),
        )
        .map((specifier) => `${path}: ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
