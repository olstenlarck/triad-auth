import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stackConfig } from "../../alchemy.run";
import { authSchemaDatabase } from "../../scripts/auth-schema-database";

function readSource(path: string): string {
  const file = resolve(repositoryRoot, path);
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

type DirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
};

const runtimeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function collectRuntimeSourcePaths(directory: string): string[] {
  const entries = readdirSync(resolve(repositoryRoot, directory), {
    withFileTypes: true,
  }) as DirectoryEntry[];

  return entries
    .flatMap((entry) => {
      const path = resolve(repositoryRoot, directory, entry.name);
      if (entry.isDirectory()) {
        return collectRuntimeSourcePaths(path);
      }

      return runtimeExtensions.has(extname(path)) ? [path] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
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
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf-8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const alchemyStackSource = readSource("alchemy.run.ts");
const schemaSource = readSource("src/better-auth/schema.ts");
const schemaDatabaseSource = readSource("scripts/auth-schema-database.ts");
const migrationFiles = readdirSync(resolve(repositoryRoot, "migrations"))
  .filter((path: string) => path.endsWith(".sql"))
  .toSorted();
const initialMigration = readSource("migrations/0001-initial.sql");

// alchemy.run.ts is a function of the deploy stage; `alchemy deploy --stage nightly` selects nightly.
const assetsConfig = {
  directory: "dist",
  htmlHandling: "drop-trailing-slash",
  notFoundHandling: "404-page",
  runWorkerFirst: false,
};

describe("Better Auth schema tooling", () => {
  it("keeps one squashed initial migration", () => {
    expect(migrationFiles).toEqual(["0001-initial.sql"]);
    expect(createHash("sha256").update(initialMigration).digest("hex")).toBe(
      "edd209690f552bfff2b7d48d68d86bd4d9f6f393c664efb43c57602a95dea58d",
    );
    expect(initialMigration).toContain('create table "user"');
    expect(initialMigration).toContain('"encryptedData" text');
    expect(initialMigration).toContain('create table "walletAddress"');
    expect(initialMigration).toContain('create table "passkey"');
    expect(initialMigration).toContain('create table "passkeyUsername"');
    expect(initialMigration).toContain('"credentialID" text not null');
    expect(initialMigration).toContain('"username" text not null unique');
    expect(initialMigration).toContain('"accountSub" text not null unique');
    expect(initialMigration).toContain('"name" text not null');
    expect(initialMigration).toContain('"email" text not null unique');
    expect(initialMigration).toContain('"emailVerified" integer not null');
    expect(initialMigration).toContain('"image" text');
    expect(initialMigration).not.toContain('"profileEmail"');
    expect(initialMigration).not.toContain('"profileEmailVerified"');
    expect(initialMigration).not.toContain('"profileHandle"');
    expect(initialMigration).not.toContain('"profileDisplayName"');
    expect(initialMigration).not.toContain('"profileAvatar"');
    expect(initialMigration).toContain('create table "deviceCode"');
    expect(initialMigration).toContain('create table "rateLimit"');
    expect(initialMigration).toContain('create table "walletRequest"');
    expect(initialMigration).toContain('"namespace" text not null');
    expect(initialMigration).toContain('"walletProfile" text not null');
    expect(initialMigration).toContain('"accountIndex" integer not null');
    expect(initialMigration).toContain('"chainId" integer');
    expect(initialMigration).toContain('"signingMessage" text not null');
    expect(initialMigration).toContain('"consumedAt" date');
    expect(initialMigration).toContain('create index "walletRequest_expiresAt_idx"');
    expect(initialMigration).toContain('create table "walletCapabilityRequest"');
    expect(initialMigration).toContain('create index "walletCapabilityRequest_expiresAt_idx"');
    expect(initialMigration).toMatch(
      /create table "passkey" \([^;]*"walletCapable" integer not null default 0, "encryptedData" text\);/,
    );
    expect(initialMigration).not.toContain("alter table");
  });

  it("configures the production Worker and D1 database for stage prod", () => {
    const { worker, database, authOrigin } = stackConfig("prod");

    expect(worker.name).toBe("triad-auth");
    expect(worker.main).toBe("src/index.ts");
    expect(worker.workersDev).toBe(false);
    expect(worker.domain).toBeNull();
    expect(worker.routes).toEqual([{ pattern: "triad-auth.wgw.lol/*", zoneName: "wgw.lol" }]);
    expect(authOrigin).toBe("https://triad-auth.wgw.lol");
    expect(database).toEqual({ name: "triad-auth", migrations: "migrations" });
  });

  it.each(["dev_user", "live_user"])(
    "keeps stage %s away from the production and nightly resources",
    (stage) => {
      const { worker, database, authOrigin } = stackConfig(stage);

      expect(worker.name).toBe(`triad-auth-${stage}`);
      expect(worker.routes).toEqual([
        { pattern: `triad-auth-${stage}.wgw.lol/*`, zoneName: "wgw.lol" },
      ]);
      expect(authOrigin).toBe(`https://triad-auth-${stage}.wgw.lol`);
      expect(database).toEqual({ name: `triad-auth-${stage}`, migrations: "migrations" });
    },
  );

  it("configures the nightly Worker and D1 database", () => {
    const { worker, database, authOrigin } = stackConfig("nightly");

    expect(worker.name).toBe("triad-auth-nightly");
    expect(worker.main).toBe("src/index.ts");
    expect(worker.workersDev).toBe(false);
    expect(worker.domain).toBeNull();
    expect(worker.routes).toEqual([
      { pattern: "triad-auth-nightly.wgw.lol/*", zoneName: "wgw.lol" },
    ]);
    expect(authOrigin).toBe("https://triad-auth-nightly.wgw.lol");
    expect(database).toEqual({ name: "triad-auth-nightly", migrations: "migrations" });
  });

  it("serves static assets with the same runtime behavior in both stages", () => {
    for (const stage of ["prod", "nightly"]) {
      expect(stackConfig(stage).worker.assets).toEqual(assetsConfig);
      expect(stackConfig(stage).worker.compatibility).toEqual({
        date: "2026-07-09",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      });
    }
  });

  it("exposes generated schema, migration, and deployment commands", () => {
    expect(packageJson.scripts["db:generate"]).toBe(
      "pnpm exec auth generate --config src/better-auth/schema.ts --output .ignore/auth-schema.sql --yes",
    );
    expect(packageJson.scripts.build).toBe("pnpm exec astro build");
    expect(packageJson.scripts["deploy:nightly"]).toBe(
      "pnpm run build && pnpm exec alchemy deploy --stage nightly",
    );
    expect(packageJson.scripts["deploy:prod"]).toBe(
      "pnpm run build && pnpm exec alchemy deploy --stage prod",
    );
    expect(packageJson.scripts.promote).toBe(
      "depot ci dispatch --repo tunnckoCoreHQ/monarch --workflow deploy-prod.yml --ref master --input app=triad-auth",
    );
    expect(packageJson.scripts.deploy).toBeUndefined();
    expect(packageJson.scripts["deploy:staging"]).toBeUndefined();
    expect(packageJson.scripts.test).toBe("vitest run");
  });

  it("does not add an adapter, emulator, SQLite driver, or legacy resource name", () => {
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ].join("\n");
    const toolingSource = [
      dependencyNames,
      JSON.stringify(packageJson.scripts),
      alchemyStackSource,
      schemaSource,
      schemaDatabaseSource,
    ].join("\n");

    expect(toolingSource).not.toMatch(
      /drizzle|miniflare|better-sqlite3|bun:sqlite|node:sqlite|sqlite3/i,
    );
    expect(toolingSource).not.toMatch(/triad-better-auth|triad-auth-broker/);
    expect(dependencyNames).not.toMatch(/^(wrangler|cf|@astrojs\/cloudflare)$/m);
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
    expect(
      resolvesToModule(
        resolve(repositoryRoot, "src/pages/index.astro"),
        specifier,
        resolve(repositoryRoot, targetPath),
      ),
    ).toBe(true);
  });

  it("does not treat a partial module name as an alias suffix", () => {
    expect(
      resolvesToModule(
        resolve(repositoryRoot, "src/pages/index.astro"),
        "schema",
        resolve(repositoryRoot, "src/better-auth/schema.ts"),
      ),
    ).toBe(false);
  });

  it("keeps the schema-only database out of every runtime module", () => {
    const schemaEntryPath = resolve(repositoryRoot, "src/better-auth/schema.ts");
    const schemaDatabasePath = resolve(repositoryRoot, "scripts/auth-schema-database.ts");
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
