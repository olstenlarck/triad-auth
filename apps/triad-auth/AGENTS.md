# Project rules

- always read `~/skills/instructions.md` - it contains everything

## Verification

Before a PR, run these sequentially and restart from the first command after any fix:

1. `turbo run check --filter=triad-auth` - monorepo root
2. `turbo run test --filter=triad-auth`
3. `turbo run build --filter=triad-auth`

## Branches and environments

- `master` is the default branch. Pull requests merge into `master`.
- The `deploy-nightly` Depot workflow deploys every `master` push that touches the app to the `triad-auth-nightly` Worker at `https://triad-auth-nightly.wgw.lol`, the `nightly` Alchemy stage.
- Production is the `prod` Alchemy stage, the `triad-auth` Worker at `https://triad-auth.wgw.lol`. Cut a production release with `pnpm run promote`, which dispatches the `deploy-prod` Depot workflow for this app on `master`. Run it only when the user asks.
- Never run `pnpm run deploy:nightly` or `pnpm run deploy:prod` locally unless the user explicitly asks. Depot CI runs them.
- Each Worker has its own D1 database and its own secrets. See `CONTRIBUTING.md`.
