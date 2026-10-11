import { defineConfig } from "vitest/config";

// The tests run in Node against the pure git and protocol code, so they skip the Cloudflare plugin.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
