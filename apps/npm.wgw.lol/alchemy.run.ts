import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const Worker = Cloudflare.Worker("Worker", {
  name: "vlt-npm-wgw-lol",
  main: "./src/index.ts",
  // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
  domain: null,
  routes: [{ pattern: "npm.wgw.lol/*", zoneName: "wgw.lol" }],
  workersDev: false,
  compatibility: { date: "2026-08-24" },
  observability: { enabled: true, headSamplingRate: 1 },
  env: {
    ALLOWED_GITHUB_LOGIN: "tunnckoCore",
    // The deploy workflow passes the commit being deployed; local deploys get "local".
    COMMIT_SHA: process.env.COMMIT_SHA ?? "local",
    // VLT service tokens and the upstream registry come from the RWX monarch_master vault.
    VLT_READ_TOKEN: Config.Redacted("VLT_READ_TOKEN"),
    VLT_WRITE_TOKEN: Config.Redacted("VLT_WRITE_TOKEN"),
    VLT_UPSTREAM_URL: Config.Redacted("VLT_UPSTREAM_URL"),
  },
});

export default Alchemy.Stack(
  "vlt-npm-wgw-lol",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
