import { bindings, defineConfig, exports, triggers } from "cf/config";

// One Worker, one environment. `deploy:nightly` deploys production on every merge to master.
const name = "localhost-wgw-lol";

export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/server.ts",
    triggers: [
      // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
      triggers.fetch({ pattern: "localhost.wgw.lol/*", zone: "wgw.lol" }),
      // Push, pull request, and import events fan out through this queue.
      triggers.queue({ name: "localhost-wgw-lol-events", maxBatchSize: 10, maxBatchTimeout: 5 }),
    ],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1 },
    // The Vite client bundle is served as static assets; every other path reaches the Worker.
    assets: { htmlHandling: "none", notFoundHandling: "none" },
    exports: {
      // One SQLite-backed Durable Object per repository: objects, refs, and the git protocol.
      RepoObject: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      APP_ORIGIN: bindings.text<string>("https://localhost.wgw.lol"),
      TRIAD_ISSUER: bindings.text<string>("https://triad-auth-nightly.wgw.lol"),
      AGENTID_ISSUER: bindings.text<string>("https://auth.agentid.com"),
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "localhost-wgw-lol", id: "ee6567b0-3234-4fcc-87fe-d9e6ff0c171c" }),
      KV: bindings.kv({ id: "fda4c4aebd2848858a235cec994cb52e" }),
      BLOBS: bindings.r2({ name: "localhost-wgw-lol" }),
      EVENTS: bindings.queue({ name: "localhost-wgw-lol-events" }),
      REPOS: bindings.durableObject({ worker: name, exportName: "RepoObject" }),
      AI: bindings.ai(),
      ANALYTICS: bindings.analyticsEngineDataset({ name: "localhost_wgw_lol" }),
      GIT_RATE_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 600, period: 60 } }),
      // The three secrets live on the Worker; `.env` holds local values.
      SESSION_SECRET: bindings.secret(),
      ENCRYPTION_KEY: bindings.secret(),
      JWT_PRIVATE_JWK: bindings.secret(),
    },
  },
});
