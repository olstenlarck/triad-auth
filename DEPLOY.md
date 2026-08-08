# Deploy Triad

Triad uses one Cloudflare Worker and one D1 database. The `prod` branch is production. The `main` branch is the stable
staging preview. No other branch deploys.

| Branch | Deployment                           | Origin                                                      |
| ------ | ------------------------------------ | ----------------------------------------------------------- |
| `prod` | Active `triad-auth` deployment       | `https://triad.wgw.lol`                                     |
| `main` | Aliased `triad-auth` preview version | `https://staging-triad-auth.equator-owl-studio.workers.dev` |

Both versions share the Worker secrets and the `triad-auth` D1 database. Their `AUTH_ORIGIN` bindings differ because
the value is captured in each uploaded Worker version.

## First-time setup

Install the locked dependencies and authenticate Wrangler:

```sh
vp install --frozen-lockfile
vp exec wrangler login
```

Create the D1 database, copy its ID into `wrangler.toml`, and apply the generated initial migration:

```sh
vp exec wrangler d1 create triad-auth
vp run db:migrate
```

The checked-in migration is generated from Better Auth. Regenerate it with `vp run db:generate`; do not edit the SQL
manually.

## Secrets

Add the required secrets to `triad-auth`:

```sh
vp exec wrangler secret put BETTER_AUTH_SECRET
vp exec wrangler secret put IDENTIFIER_SECRET
vp exec wrangler secret put PROFILE_DATA_KEYRING
```

`PROFILE_DATA_KEYRING` is a JSON keyring:

```json
{ "active": "v1", "keys": { "v1": "<independent high-entropy key material>" } }
```

Each enabled provider also needs its client ID and secret:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`

Register both the production and staging callback origins with each enabled provider.

## Cloudflare Workers Builds

Connect the repository to the existing `triad-auth` Worker and configure:

| Setting                            | Value                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| Production branch                  | `prod`                                                               |
| Builds for non-production branches | Enabled                                                              |
| Build command                      | `vp run check && git diff --exit-code && vp run build`               |
| Deploy command                     | `vp run deploy`                                                      |
| Non-production deploy command      | `if [ "$WORKERS_CI_BRANCH" = main ]; then vp run deploy:staging; fi` |
| Root directory                     | `/`                                                                  |

Cloudflare runs the non-production command for every non-production branch. The branch guard uploads a version only
for `main`, so pull-request branches perform no deployment and receive no preview version.

The `prod` deployment uses the production `AUTH_ORIGIN` from `wrangler.toml`. The `main` command overrides that binding
only for its preview version and moves the stable `staging` alias to the new version.

D1 migrations are intentionally separate from Workers Builds. Apply a schema change once with `vp run db:migrate`
before deploying code that requires it. Cloudflare's automatically managed Workers Builds token does not include D1
write permission.

## Manual deployment

Run the required checks and build first:

```sh
vp run check
vp run build
```

Then deploy the current checkout as production or upload it as staging:

```sh
vp run deploy
vp run deploy:staging
```
