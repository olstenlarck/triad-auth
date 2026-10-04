import { defineConfig } from "tsdown";

// One bundle per public entry; the package.json exports map lists the same four files. The
// package hashes cache keys with node:crypto, so the platform is node.
export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts", "src/types.ts", "src/utils.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  clean: true,
});
