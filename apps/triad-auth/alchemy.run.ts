import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// One Worker per stage. `--stage nightly` targets `triad-auth-nightly`; every other stage targets
// `triad-auth`. Each Worker has its own D1 database, its own secrets, and its own AUTH_ORIGIN.
const workers = {
  production: { name: "triad-auth", database: "triad-auth" },
  nightly: { name: "triad-auth-nightly", database: "triad-auth-nightly" },
} as const;

export function stackConfig(stage: string) {
  const target = stage === "nightly" ? workers.nightly : workers.production;
  const host = `${target.name}.wgw.lol`;

  return {
    // Alchemy adopts the database by name and takes over the `d1_migrations` history that
    // `cf d1 migrations apply` left in it, then applies pending migrations on every deploy.
    database: {
      name: target.database,
      migrations: "migrations",
    } satisfies Cloudflare.D1.DatabaseProps,
    worker: {
      name: target.name,
      main: "src/index.ts",
      // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
      domain: null,
      routes: [{ pattern: `${host}/*`, zoneName: "wgw.lol" }],
      workersDev: false,
      compatibility: {
        date: "2026-07-09",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      observability: { enabled: true },
      // `astro build` prerenders every page into dist/; the Worker serves only the auth API.
      assets: {
        directory: "dist",
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: false,
      },
    } satisfies Cloudflare.WorkerProps,
    authOrigin: `https://${host}`,
  };
}

export default Alchemy.Stack(
  "triad-auth",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const config = stackConfig(yield* Alchemy.Stage);
    const database = yield* Cloudflare.D1.Database("Database", config.database);
    const worker = yield* Cloudflare.Worker("Worker", {
      ...config.worker,
      env: {
        AUTH_ORIGIN: config.authOrigin,
        DB: database,
        // The ten secrets come from the environment at deploy time: the Depot CI secrets in the
        // deploy workflows, `.env` locally. A missing one fails the plan before any upload.
        BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
        IDENTIFIER_SECRET: Config.Redacted("IDENTIFIER_SECRET"),
        RATE_LIMIT_SECRET: Config.Redacted("RATE_LIMIT_SECRET"),
        ENCRYPTION_SECRETS: Config.Redacted("ENCRYPTION_SECRETS"),
        GOOGLE_CLIENT_ID: Config.Redacted("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: Config.Redacted("GOOGLE_CLIENT_SECRET"),
        GITHUB_CLIENT_ID: Config.Redacted("GITHUB_CLIENT_ID"),
        GITHUB_CLIENT_SECRET: Config.Redacted("GITHUB_CLIENT_SECRET"),
        TWITTER_CLIENT_ID: Config.Redacted("TWITTER_CLIENT_ID"),
        TWITTER_CLIENT_SECRET: Config.Redacted("TWITTER_CLIENT_SECRET"),
      },
    });

    return { url: worker.url };
  }),
);
