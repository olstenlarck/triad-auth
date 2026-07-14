import { mkdir, writeFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./schema-config";

const output = new URL("../migrations/better-auth.sql", import.meta.url);
const { compileMigrations } = await getMigrations(authOptions);
const sql = await compileMigrations();

await mkdir(new URL("../migrations/", import.meta.url), { recursive: true });
await writeFile(output, `${sql}\n`, "utf8");

console.log("Generated migrations/better-auth.sql");
