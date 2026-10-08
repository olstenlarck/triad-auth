import cloudflare from "@astrojs/cloudflare";
import { defineConfig, sessionDrivers } from "astro/config";

export default defineConfig({
  // The adapter reads cloudflare.config.ts; `--mode nightly` selects the nightly Worker.
  adapter: cloudflare({ imageService: "passthrough" }),
  // Every page prerenders; the Worker in src/index.ts serves the auth API and the built assets.
  output: "server",
  // Triad owns browser sessions in D1; this prevents an unused KV binding.
  session: { driver: sessionDrivers.lruCache() },
  trailingSlash: "never",
  build: { format: "directory" },
  vite: {
    define: {
      // The deploy workflows pass the commit being deployed; local builds get "local".
      "import.meta.env.COMMIT_SHA": JSON.stringify(process.env.COMMIT_SHA ?? "local"),
    },
  },
});
