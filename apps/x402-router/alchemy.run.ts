import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const Website = Cloudflare.Website.Astro("Website", {
  name: "x402-router",
  // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
  domain: null,
  routes: [{ pattern: "x402-router.wgw.lol/*", zoneName: "wgw.lol" }],
  compatibility: {
    date: "2026-06-19",
    flags: ["nodejs_compat", "global_fetch_strictly_public"],
  },
  observability: { enabled: true },
  assets: {
    // The x402 facilitator API is served by the Worker; everything else is a static asset first.
    runWorkerFirst: ["/supported", "/verify", "/settle", "/health", "/healthz"],
  },
  // Sessions use the in-memory driver from astro.config.mjs, so no KV namespace is needed.
  sessionKVBindingName: false,
  // Starlight prerenders through satteri, whose workerd build needs a WASM package pnpm does not
  // install on this platform, so prerendering runs in Node. The deployed Worker is unaffected.
  prerenderEnvironment: "node",
});

export default Alchemy.Stack(
  "x402-router",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Website;
    return { url: site.url };
  }),
);
