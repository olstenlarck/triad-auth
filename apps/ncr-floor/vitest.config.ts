import { defineConfig } from "vitest/config";

// The tests cover the pure burst logic in Node, so they skip the Cloudflare plugin in vite.config.ts.
export default defineConfig({});
