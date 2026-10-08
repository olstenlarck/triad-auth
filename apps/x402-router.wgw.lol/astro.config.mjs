import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

// https://astro.build/config
export default defineConfig({
  // The adapter reads cloudflare.config.ts.
  adapter: cloudflare({ imageService: "passthrough" }),
  output: "server",
  session: { driver: sessionDrivers.lruCache() },
  security: {
    checkOrigin: false,
  },
  site: "https://x402-router.wgw.lol",
  vite: {
    define: {
      // The deploy workflow passes the commit being deployed; local builds get "local".
      "import.meta.env.COMMIT_SHA": JSON.stringify(process.env.COMMIT_SHA ?? "local"),
    },
    plugins: [tailwindcss()],
  },
});
