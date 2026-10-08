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

// One Worker and one D1 database per stage. `prod` targets `triad-auth` and `nightly` targets
// `triad-auth-nightly`. Any other stage, such as the `dev_<user>` stage of `alchemy dev`, gets its
// own names, so it never touches those two. Each Worker has its own secrets and AUTH_ORIGIN.
export function stackConfig(stage: string) {
  const name = stage === "prod" ? "triad-auth" : `triad-auth-${stage}`;
  const host = `${name}.wgw.lol`;

  return {
    // Alchemy adopts the database by name and takes over the `d1_migrations` history that
    // `cf d1 migrations apply` left in it, then applies pending migrations on every deploy.
    database: {
      name,
      migrations: "migrations",
    } satisfies Cloudflare.D1.DatabaseProps,
    worker: {
      name,
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
    // The database holds the accounts, sessions, and JWKS: `alchemy destroy` leaves it in place.
    const database = yield* Cloudflare.D1.Database("Database", config.database).pipe(
      Alchemy.RemovalPolicy.retain(),
    );
    const worker = yield* Cloudflare.Worker("Worker", {
      ...config.worker,
      env: {
        AUTH_ORIGIN: config.authOrigin,
        DB: database,
        // The ten secrets, from `.env.nightly` or `.env.prod`.
        ...secrets(
          "BETTER_AUTH_SECRET",
          "IDENTIFIER_SECRET",
          "RATE_LIMIT_SECRET",
          "ENCRYPTION_SECRETS",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "TWITTER_CLIENT_ID",
          "TWITTER_CLIENT_SECRET",
        ),
      },
    });

    return { url: worker.url };
  }),
);
