import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.cloudflare/**", "**/solidity/**"],
    globals: true,
    include: ["**/test/**/*.test.ts"],
  },
});
