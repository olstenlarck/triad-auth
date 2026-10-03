import { defineConfig } from "tsdown";

// Two entries, one bundle each. Dependencies stay external; devDependencies are bundled in.
export default defineConfig({
  entry: ["src/index.ts", "src/cdp.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
});
