// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vite-plus/test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const acceptsD1Database = (database: D1Database): BetterAuthOptions["database"] => database;

describe("Better Auth package baseline", () => {
  it("pins every RC.1 runtime package", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@better-auth/cimd": "1.7.0-rc.1",
      "@better-auth/oauth-provider": "1.7.0-rc.1",
      "better-auth": "1.7.0-rc.1",
    });
    expect(packageJson.devDependencies.auth).toBe("1.7.0-rc.1");
  });

  it("exposes the required public factories", () => {
    expect(betterAuth).toBeTypeOf("function");
    expect(jwt).toBeTypeOf("function");
    expect(oauthProvider).toBeTypeOf("function");
    expect(cimd).toBeTypeOf("function");
  });

  it("accepts the Cloudflare D1 binding without an ORM adapter", () => {
    const database = {} as D1Database;

    expect(acceptsD1Database(database)).toBe(database);
  });
});
