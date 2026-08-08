# Deploy Triad

Triad deploys to Cloudflare Workers with one D1 database per environment. The repository defaults are:

| Environment | Worker               | D1 database          | Deploy command          |
| ----------- | -------------------- | -------------------- | ----------------------- |
| Production  | `triad-auth`         | `triad-auth`         | `vp run deploy`         |
| Staging     | `triad-auth-staging` | `triad-auth-staging` | `vp run deploy:staging` |

Forks should replace these names and origins with names owned by their Cloudflare account.

## Prerequisites

- A Cloudflare account with Workers and D1 enabled.
- Vite+ (`vp`) installed.
- Wrangler authenticated with `vp exec wrangler login`.

Install the locked dependencies before running any project command:

```sh
vp install --frozen-lockfile
```

## Configure the environments

Set the production and staging Worker names, public `AUTH_ORIGIN` values, D1 names, and D1 IDs in `wrangler.toml`.
The production origin must be the canonical public issuer. Staging normally uses its `workers.dev` URL.

The repository keeps production `workers_dev = false` because `triad.wgw.lol` is attached in the Cloudflare dashboard.
For a new deployment, either attach a custom domain there or set `workers_dev = true` and use the resulting stable
`workers.dev` URL as `AUTH_ORIGIN`.

Create one database for each environment:

```sh
vp exec wrangler d1 create triad-auth
vp exec wrangler d1 create triad-auth-staging
```

Copy each returned `database_id` into its matching D1 binding in `wrangler.toml`. Do not deploy a fork with the
database IDs committed by this repository; D1 IDs belong to one Cloudflare account.

## Configure Worker secrets

Every environment requires three independent secrets:

- `BETTER_AUTH_SECRET`: at least 32 characters.
- `IDENTIFIER_SECRET`: a strong value of at least 32 characters used to derive opaque identifiers.
- `PROFILE_DATA_KEYRING`: a JSON keyring whose active key contains at least 32 characters.

The profile keyring has this shape:

```json
{ "active": "v1", "keys": { "v1": "<independent high-entropy key material>" } }
```

Do not reuse secret material between these values. Add secrets interactively so their values never enter shell history:

```sh
vp exec wrangler secret put BETTER_AUTH_SECRET
vp exec wrangler secret put IDENTIFIER_SECRET
vp exec wrangler secret put PROFILE_DATA_KEYRING
```

Repeat the same commands with `--env staging` for staging:

```sh
vp exec wrangler secret put BETTER_AUTH_SECRET --env staging
vp exec wrangler secret put IDENTIFIER_SECRET --env staging
vp exec wrangler secret put PROFILE_DATA_KEYRING --env staging
```

Wrangler may offer to create a Worker when its first secret is added. Provider login is optional, but each enabled
provider needs both values in each environment:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`

Add provider values with the same interactive `wrangler secret put` commands. Configure each provider's OAuth
callback against the environment's canonical origin.

## Deploy manually

Validate the repository first:

```sh
vp run check
vp run build
```

Deploy production:

```sh
vp run deploy
```

Deploy staging:

```sh
vp run deploy:staging
```

Both commands build the matching environment, apply pending D1 migrations, and then deploy its Worker. A failed build
stops before the database or Worker is changed.

The checked-in schema is generated from the Better Auth configuration. While the project is resetting prototype
databases instead of preserving existing users, regenerate the single initial migration with:

```sh
vp run db:generate
```

Do not hand-edit the generated SQL.

## Pull-request staging deploys

Use Cloudflare Workers Builds instead of storing Cloudflare credentials in GitHub Actions. Cloudflare manages the
build token and reports build status directly on pull requests.

Open the existing `triad-auth-staging` Worker in the Cloudflare dashboard, go to **Settings → Builds**, and connect the
GitHub repository. Configure it with:

| Setting                              | Value                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Production branch                    | `main`                                                                                                 |
| Build non-production branches        | Enabled                                                                                                |
| Build command                        | `./node_modules/.bin/vp run check && git diff --exit-code && ./node_modules/.bin/vp run build:staging` |
| Deploy command                       | `./node_modules/.bin/vp exec wrangler deploy --env staging`                                            |
| Non-production branch deploy command | `./node_modules/.bin/vp exec wrangler deploy --env staging`                                            |
| Root directory                       | `/`                                                                                                    |

The check command formats and lints with fixes, runs type checks and the production build, and performs a Wrangler dry run. The
`git diff` guard rejects a build if those fixes were not committed. Only a successful build reaches the deploy
command.

Cloudflare triggers non-production builds on branch pushes, comments on associated pull requests, and deploys the
latest successful branch build to the shared staging Worker. This is intentional: Triad's OAuth issuer and callback
must remain the canonical staging origin, so isolated preview-version URLs cannot represent the complete auth flow.

Workers Builds' automatically managed token deploys Workers but does not include D1 edit permission. The staging D1
database is already initialized; when a pull request intentionally changes the schema, apply its migration separately
with `vp run db:migrate:staging` before relying on the staging deployment. Runtime application secrets remain attached
to the Worker and are not copied into the build configuration.
