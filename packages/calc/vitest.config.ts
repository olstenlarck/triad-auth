import { defineConfig } from "vitest/config";

// lcovonly feeds scripts/coverage-badge.ts at the repository root, which reads coverage/lcov.info.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["index.js"],
      reporter: ["text", "lcovonly"],
    },
  },
});
