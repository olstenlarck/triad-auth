import { defineConfig } from "tsdown";

// One bundle per public entry; the package.json exports map lists the same four files.
export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts", "src/types.ts", "src/utils.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
});
