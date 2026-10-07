import { defineConfig } from "astro/config";

export default defineConfig({
  // Every page prerenders; the Worker in src/index.ts serves the auth API and the built assets.
  output: "static",
  trailingSlash: "never",
  build: { format: "directory" },
  vite: {
    define: {
      // The deploy workflows pass the commit being deployed; local builds get "local".
      "import.meta.env.COMMIT_SHA": JSON.stringify(process.env.COMMIT_SHA ?? "local"),
    },
  },
});
