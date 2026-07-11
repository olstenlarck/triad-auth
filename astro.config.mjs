import cloudflare from "@astrojs/cloudflare";
import { defineConfig, sessionDrivers } from "astro/config";

export default defineConfig({
  adapter: cloudflare({ imageService: "passthrough" }),
  output: "server",
  // Triad owns browser sessions in D1; this prevents an unused KV binding.
  session: { driver: sessionDrivers.lruCache() },
  trailingSlash: "always",
  build: { format: "directory" },
});
