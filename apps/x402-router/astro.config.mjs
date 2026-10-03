import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

// https://astro.build/config
// Alchemy injects the Cloudflare adapter at deploy time; see alchemy.run.ts.
export default defineConfig({
  integrations: [
    starlight({
      customCss: ["./src/styles.css"],
      editLink: {
        baseUrl:
          "https://github.com/tunnckoCoreHQ/monarch/tree/master/apps/x402-router/src/content/docs/",
      },
      sidebar: [
        {
          items: ["docs/index", "docs/getting-started", "docs/integration"],
          label: "Start",
        },
        {
          items: ["docs/upstreams", "docs/self-hosting", "docs/license"],
          label: "Operate",
        },
      ],
      title: "x402-router",
    }),
  ],
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
