import { defineConfig } from "vitest/config";

// lcovonly feeds scripts/coverage-badge.ts, which reads coverage/lcov.info.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcovonly"],
    },
  },
});
