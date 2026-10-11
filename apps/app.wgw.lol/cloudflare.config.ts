import { bindings, defineConfig, exports, triggers } from "cf/config";

const ORIGIN = "https://app.wgw.lol";

export default defineConfig({
  worker: {
    name: "app-wgw-lol",
    compatibilityDate: "2026-09-28",
    // Calls to Triad on the same zone must take the public path, or Cloudflare answers 522.
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/server.ts",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [triggers.fetch({ pattern: "app.wgw.lol/*", zone: "wgw.lol" })],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1 },
    // One SQLite Durable Object per repository holds its git objects, refs, and public projection.
    exports: { Repo: exports.durableObject({ storage: "sqlite" }) },
    env: {
      ORIGIN: bindings.text<string>(ORIGIN),
      TRIAD_ISSUER: bindings.text("https://triad-auth-nightly.wgw.lol/api/auth"),
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
      REPO: bindings.durableObject({ worker: "app-wgw-lol", exportName: "Repo" }),
      // Accounts, tokens, repository metadata, pull requests, environments, and activity.
      DB: bindings.d1({ name: "app-wgw-lol", id: "083f7b02-3ae2-49bd-b7f2-184d2927fec2" }),
      // Blobs over 1 MB and an archive of every pushed pack.
      GIT: bindings.r2({ name: "app-wgw-lol-git" }),
      // Short-lived sign-in state and rendered README cache.
      CACHE: bindings.kv({ id: "62b8e0bae315469ab347a692df78bf79" }),
      // Pull request summaries.
      AI: bindings.ai(),
      // Counts of clones, fetches, and pushes per repository.
      METRICS: bindings.analyticsEngineDataset({ name: "app_wgw_lol_git" }),
      // Sign-in, device-code, and agent-registration endpoints.
      LIMITER: bindings.rateLimit({ namespace: "4201", simple: { limit: 30, period: 60 } }),
      ASSETS: bindings.assets(),
      // AES-GCM key for repository secrets: 32 random bytes, base64.
      SECRETS_KEY: bindings.secret(),
      // ES256 private key, PKCS#8 PEM, that signs auth.md identity assertions.
      SIGNING_KEY: bindings.secret(),
    },
  },
});
