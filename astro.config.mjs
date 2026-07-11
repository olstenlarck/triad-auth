import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: cloudflare({ imageService: "passthrough" }),
  output: "server",
  trailingSlash: "always",
  build: { format: "directory" },
});
