---
name: contributing
description: How to develop in the monarch monorepo. Use before changing code, adding a package, app, or Solidity project, running checks, or opening a pull request.
---

# Contributing

## Layout

- TypeScript packages live in `packages/*`. Scoped `@tunnckocore/*` packages publish to the VLT registry at `npm.wgw.lol`. Unscoped packages publish to npmjs.com.
- Cloudflare apps live in `apps/*`. They deploy primarily with Alchemy (`alchemy.run.ts`). An app can also use the Vite-based `cloudflare.config.ts`.
- Solidity projects live in `solidity/*` and build with Foundry.
- Chrome extensions live in `chrome-extensions/*`, load unpacked, and have only a `check` script.
- The workspace runs on pnpm and Turborepo. TypeScript uses ultracite (oxlint, oxfmt, tsgolint) and Vitest.

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
- A two-environment app, like `apps/triad-auth`, has `deploy:nightly` for the nightly stage and `deploy:prod` for production. Its `promote` script dispatches the Depot `deploy-prod` workflow, which runs `deploy:prod`.
- For each secret: add a Depot secret, pass it under `env` of the deploy step in `.depot/workflows/deploy-nightly.yml` and `deploy-prod.yml`, and add it to `passThroughEnv` of the deploy tasks in `turbo.json`.
- The app needs no workflow of its own.
- Never run a deploy or `promote` script locally unless the user asks.

## CI and releases

- CI runs on Depot CI from `.depot/workflows/`. GitHub Actions only publishes unscoped packages and handles `/approve` comments.
- Renovate updates dependencies from `renovate.json5`. Dependabot is off; its old config is `.github/dependabot.yml.disabled`.
- The `ci` workflow runs `check`, `test`, and `build` on pull requests and on `master`.
- A push to `master` publishes `nightly` packages and runs `deploy:nightly` for the apps it changed.
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
- Required checks: `ci / check`, `ci / test`, and `ci / build`. The branch must be up to date with `master`.
- 5 approvals, and the latest push needs an approval from someone other than its author.
- A new push dismisses earlier approvals.
- Every review thread must be resolved.
- Repository admins can bypass the ruleset.
