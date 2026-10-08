---
name: contributing
description: How to develop in the monarch monorepo. Use before changing code, adding a package, app, or Solidity project, running checks, or opening a pull request.
---

# Contributing

## Layout

- TypeScript packages live in `packages/*`. Scoped `@tunnckocore/*` packages publish to the VLT registry at `npm.wgw.lol`. Unscoped packages publish to npmjs.com.
- Cloudflare apps live in `apps/*`. Most deploy with Alchemy from `alchemy.run.ts`. An app can instead use `cloudflare.config.ts`, the typed config of the new Cloudflare CLI `cf` (beta): `cf build` runs Vite with the Cloudflare Vite plugin, and `cf deploy` deploys.
- Solidity projects live in `solidity/*` and build with Foundry.
- Chrome extensions live in `chrome-extensions/*`, load unpacked, and have only a `check` script.
- The workspace runs on pnpm and Turborepo. TypeScript uses ultracite (oxlint, oxfmt, tsgolint) and Vitest.
- Dependency versions come from the catalogs in `pnpm-workspace.yaml`.

## Commands

- Run `pnpm install` once. It also installs the Git hooks from `.githooks`.
- Run `turbo run check test` to check and test everything, TypeScript and Solidity. Add `--affected` to run only what the branch changed; unchanged tasks replay from the cache.
- Tasks are `check`, `test`, `fmt`, `lint`, `build`, `deploy:nightly`, and `deploy:prod`. Run them through turbo, never through pnpm filters.
- Run other scripts with `pnpm --filter <pkg> run <script>`, and binaries with `pnpm exec`.
- The pre-commit hook runs `check --affected`. The pre-push hook runs `check test` for pushes to `master`.

## New Solidity project

- Copy `solidity/template/` to `solidity/<name>`.
- Edit the `name`, `description`, and `repository.directory` fields in `package.json`, then the README.
- Add Solidity dependencies with pnpm, not `forge install`.
- Put docs in `solidity/<name>/docs`.
- Use custom errors with `revert`. Never use `require`.

## New package

- Create `packages/<name>` with `package.json`, and `tsconfig.json` that extends `../../tsconfig.json`.
- Add a `check` script (`ultracite fix --type-aware --type-check`) and a `test` script (`vitest run`).
- Add a `build` script only when the package emits or bundles.
- Point `exports` at the source, for example `./src/index.ts`. Point `publishConfig.exports` at `dist`. The workspace and the tests use the source, and the published package uses the build.
- When a test must run against `dist`, add a package `turbo.json` that extends `//` and makes `test` depend on `build`, like `packages/zagora/turbo.json`.
- Every package needs a `repository` field with the monarch URL and its `directory`.
- Every package change needs a Changeset: `pnpm changeset`.

## New app

- Create `apps/<name>` with `package.json`, `alchemy.run.ts`, and `tsconfig.json` that extends the root one.
- Add `check` and `test` scripts.
- The `deploy:nightly` script runs on every merge to `master`. It does not mean unstable.
- A one-environment app, like `apps/npm.wgw.lol` or `apps/x402-router.wgw.lol`, has only `deploy:nightly`, and that script deploys production.
- A two-environment app, like `apps/triad-auth`, has `deploy:nightly` for the nightly stage and `deploy:prod` for production. Its `promote` script runs the `deploy-prod.yml` workflow, which runs `deploy:prod`.
- Worker secrets live only on the Workers in Cloudflare. CI passes none, and a deploy keeps the secrets the Worker already has, through `patches/alchemy@2.0.0-beta.80.patch`. To add or rotate one, list it in the `secrets(...)` call of `alchemy.run.ts`, then deploy once locally with it exported: `set -a; . ./.env.<stage>; set +a`.
- The app needs no workflow of its own.
- Never run a deploy script locally unless the user asks.

## CI and releases

- CI runs on GitHub Actions with Namespace runners (the `namespace-profile-monarch` profile) from `.github/workflows/`. `ci.yml` checks, tests, and builds pull requests and `master`. After it passes on a `master` push, `publish-nightly.yml`, `prepare-publish.yml`, `deploy-nightly.yml`, and `publish-prod.yml` (for the merged release PR) run on their own, so none of them appear on pull requests. `deploy-prod.yml`, `socket-optimize.yml`, and the others run by hand with `gh workflow run <file>`. `.github/actions/setup` installs the toolchain and points turbo at the Namespace Turborepo cache; pull requests only read it.
- The old RWX, Depot, and GitHub Actions configurations stay in `.rwx-disabled/`, `.depot/workflows-disabled/`, and `.github/workflows-disabled/`, which no service reads.
- The repository secrets are `OLSTENLARCK_HQ_PAT`, `NPM_TOKEN`, `SOCKET_SECURITY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`. npm.wgw.lol takes the GitHub OIDC token of `publish-nightly.yml` on `master` for `nightly` and of `publish-prod.yml` on `master` for `latest`.
- Locally, `export $(nsc cache turborepo setup --team main)` points turbo at the same cache. Run `nsc login` once first.
- Renovate opens every dependency pull request, from `renovate.json5`. Dependabot only raises security alerts, which Renovate reads.
- The `ci` workflow checks, tests, and builds on pull requests and on `master`.
- After those pass, a push to `master` publishes `nightly` packages, runs `deploy:nightly` for the apps it changed, and opens or updates the release pull request.
- The release pull request (`chore: release packages`) publishes `latest`. The owner merges it by hand.
- Production deploys of two-environment apps run only by hand and only when the user asks: `promote` for one app, `pnpm run apps:deploy:prod` for all.

## Pull requests

- Use conventional commits.
- Keep one task per pull request. Open another pull request only when the user asks for it.
- Open with `gh pr create`, then run `gh pr merge --auto --squash`. Never merge by hand.
- Never enable auto-merge on the release pull request.
- Greptile does not review on its own. Comment `@greptileai review` to request a review.
- Do not approve a pull request unless the user says so.
- Push to `master` directly only when the user asks.

The master ruleset:

- Squash merges only, with linear history and signed commits.
- No force pushes and no branch deletion.
- Required checks: the GitHub Actions `check`, `test`, and `build` jobs. The branch must be up to date with `master`.
- 5 approvals, and the latest push needs an approval from someone other than its author.
- A new push dismisses earlier approvals.
- Every review thread must be resolved.
- Repository admins can bypass the ruleset.
