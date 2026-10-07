import { defineConfig } from "tsdown";

// One executable bundle for the `bin` entry. tsdown defaults to .mjs on node; the bin field expects
// .js. viem stays a dependency, so it is not bundled.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  clean: true,
});
