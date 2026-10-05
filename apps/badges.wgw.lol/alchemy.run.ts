import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const Worker = Cloudflare.Worker("Worker", {
  name: "badges-wgw-lol",
  main: "./src/index.ts",
  // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
  domain: null,
  routes: [{ pattern: "badges.wgw.lol/*", zoneName: "wgw.lol" }],
  workersDev: false,
  compatibility: { date: "2026-08-24" },
  observability: { enabled: true, headSamplingRate: 1 },
  env: {
    // A Depot organization token for pcnr2v598s, from the BADGES_DEPOT_TOKEN Depot CI secret.
    DEPOT_TOKEN: Config.Redacted("BADGES_DEPOT_TOKEN"),
  },
});

export default Alchemy.Stack(
  "badges-wgw-lol",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
