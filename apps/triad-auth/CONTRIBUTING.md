# Contributing

Triad is a Better Auth OAuth/OIDC server on Cloudflare Workers, D1, and Astro. This file describes the whole flow from a local change to production.

## Environments

| Stage | Worker | D1 | Origin | Deployed by |
| --- | --- | --- | --- | --- |
| `nightly` | `triad-auth-nightly` | `triad-auth-nightly` | `https://triad-auth-nightly.wgw.lol` | `deploy-nightly`, after every `master` push that touches the app |
| `prod` | `triad-auth` | `triad-auth` | `https://triad-auth.wgw.lol` | `deploy-prod`, started by hand |

`master` is the default branch. Every pull request targets it. Nothing deploys from a pull request or from any other branch.

Both Workers are described by one `alchemy.run.ts`. The stack is a function of the Alchemy stage: `--stage prod` selects `triad-auth`, `--stage nightly` selects `triad-auth-nightly`, and any other stage gets its own `triad-auth-<stage>` Worker and database. The two Workers share nothing. Each has its own D1 database, its own secrets, and its own `AUTH_ORIGIN`. Alchemy keeps the stack state in the remote Cloudflare state store.

## Local development

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run build
pnpm run dev
```

Fill `.env` with local values. `pnpm run dev` runs `alchemy dev`, which serves the Worker from `src/index.ts` with the secrets from `.env`, a local D1 database with the migrations applied, and the pages built into `dist/`. Run `pnpm run build` again after changing a page.

## Making a change

1. Branch from `master`.
2. Make the change. For a schema change, add a new numbered file in `migrations/`. Never edit `migrations/0001-initial.sql` or any migration already applied.
3. Run the checks in this order and restart from the first after any fix:

   ```sh
   turbo run check --filter=triad-auth
   turbo run test --filter=triad-auth
   turbo run build --filter=triad-auth
   ```

4. Open a pull request into `master`. The `ci` workflow checks and tests the affected packages on Namespace runners. Nothing deploys from a pull request. Enable auto-merge with `gh pr merge --auto --squash`; GitHub merges once the required checks pass, one approval is in, and review threads are resolved.
5. Squash-merge. The `deploy-nightly` job runs after `check`, `test`, and `build` pass on `master`: it builds the pages, applies pending migrations to the nightly database, and uploads the Worker.

## Releasing to production

Confirm nightly is healthy at `https://triad-auth-nightly.wgw.lol`, then:

```sh
pnpm run promote
```

This runs the `deploy-prod.yml` workflow for this app on `master`. It builds the pages from the `master` head, applies pending migrations to the production database, and uploads the `triad-auth` Worker. `pnpm run apps:deploy:prod` from the repository root does the same for every app with a `deploy:prod` script.

Every page footer shows a `BUILD <sha>` link with the commit the running Worker was built from.

## Build and deploy scripts

| Script                    | What it does                                            |
| ------------------------- | ------------------------------------------------------- |
| `pnpm run build`          | `astro build`: prerenders every page into `dist/`       |
| `pnpm run deploy:nightly` | `pnpm run build`, then `alchemy deploy --stage nightly` |
| `pnpm run deploy:prod`    | `pnpm run build`, then `alchemy deploy --stage prod`    |
| `pnpm run promote`        | runs `deploy-prod.yml` for `triad-auth`                 |

`alchemy deploy` bundles `src/index.ts`, uploads `dist/` as the Worker's static assets, applies the pending files in `migrations/` to the stage's D1 database, and sets the secrets from the environment. GitHub Actions runs the deploy scripts. Do not run them by hand unless asked; a local deploy needs the `cf-equator` Alchemy profile and the ten secrets in the environment, and `alchemy deploy` reads `.env` from this folder, so a local deploy uploads the values in that file.

## Secrets

Each Worker needs the same ten secret names. The stack reads them from the environment at deploy time, so they live in the `nightly` and `latest` GitHub environments, which allow only `master`. The `nightly` environment holds the nightly values and the `latest` environment the prod values. The first four in the table differ per Worker. The six provider values are the same in both environments, because one OAuth app per provider registers both callback origins. GitHub secret names cannot start with `GITHUB_`, so the GitHub OAuth app values are stored as `GH_CLIENT_ID` and `GH_CLIENT_SECRET`, and the workflows pass them as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. A missing secret fails the Alchemy plan before anything is uploaded. Set or rotate one with `gh secret set <NAME> --env <nightly|latest>`, then redeploy. A secret set on the Worker directly is overwritten by the next deploy.

| Name | Value |
| --- | --- |
| `BETTER_AUTH_SECRET` | 32 random bytes, base64url |
| `IDENTIFIER_SECRET` | 32 random bytes, base64url, distinct from the others |
| `RATE_LIMIT_SECRET` | 32 random bytes, base64url, distinct from the others |
| `ENCRYPTION_SECRETS` | `{"active":"k1","secrets":{"k1":"<43-char base64url of 32 random bytes>"}}` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Google Cloud console |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the GitHub OAuth app |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | From the X developer portal |

Generate random values with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Never reuse one of the first four values between the two Workers. Better Auth owns ES256 signing and JWKS persistence, so there is no signing secret.

Register the callback URI `/api/auth/callback/<provider>` on both origins with each provider.

## First-time setup

Done once per Cloudflare account. Skip this if both Workers already exist.

Set the environment secrets, then deploy each stage once from GitHub Actions: merge the app to `master` for nightly and run `pnpm run promote` for production. Alchemy creates each stage's D1 database, Worker, and route, and applies the migrations. Create two proxied DNS records in the `wgw.lol` zone, `triad-auth-nightly` and `triad-auth`, so the route patterns resolve.

GitHub Actions runs the checks and the deploys on Namespace runners.
