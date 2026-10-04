import { defineConfig } from "tsdown";

// One bundle per public entry; the package.json exports map lists the same four files. The
// package hashes cache keys with node:crypto, so the platform is node. tsdown defaults to .mjs on
// node; the exports map and the dist test expect .js and .d.ts.
export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts", "src/types.ts", "src/utils.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
});
