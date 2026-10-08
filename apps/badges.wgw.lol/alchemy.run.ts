import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// Sets only the secrets exported in the shell, for a first deploy or a rotation:
// `set -a; . ./.env.<stage>; set +a` before the deploy. CI passes none, and the deploy keeps the secrets
// the Worker already has (patches/alchemy@2.0.0-beta.80.patch).
// SAFETY: the Worker keeps every secret a deploy does not pass, so each name is bound at runtime.
const secrets = <const Name extends string>(...names: Name[]) =>
  Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, Config.Redacted(name)]),
  ) as Record<Name, ReturnType<typeof Config.Redacted>>;

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
    // The deploy workflow passes the commit being deployed; local deploys get "local".
    COMMIT_SHA: process.env.COMMIT_SHA ?? "local",
    // A Depot organization token for pcnr2v598s.
    ...secrets("BADGES_DEPOT_TOKEN"),
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
