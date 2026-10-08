---
name: contributing
description: How to develop in the monarch monorepo. Use before changing code, adding a package, app, or Solidity project, running checks, or opening a pull request.
---

# Contributing

## Layout

- TypeScript packages live in `packages/*` and publish to npm.
- Cloudflare apps live in `apps/*` and deploy with Alchemy.
- Solidity projects live in `solidity/*` and build with Foundry.
- Chrome extensions live in `chrome-extensions/*`, load unpacked, and have only a `check` script.
- The workspace runs on pnpm and Turborepo. TypeScript uses ultracite (oxlint, oxfmt, tsgolint) and Vitest.
- Dependency versions come from the catalogs in `pnpm-workspace.yaml`. Write `catalog:` in `package.json`.

## Commands

- Run `pnpm install` once. It also installs the Git hooks from `.githooks`.
- Run turbo tasks per package: `turbo run check --filter=<pkg>` and `turbo run test --filter=<pkg>`.
- Use `--affected` to cover everything the branch changed.
- Check the root files with `turbo run check --filter=//`.
- Tasks are `check`, `test`, `fmt`, `lint`, `build`, `deploy:nightly`, and `deploy:prod`. Run them through turbo, never through pnpm filters.
- Run other scripts with `pnpm --filter <pkg> run <script>`, and binaries with `pnpm exec`.
- The `check` task fixes files in place. Review and stage what it changes.
- The pre-commit hook runs `check --affected`. The pre-push hook runs `check test` for pushes to `master`.

## New Solidity project

- Copy `solidity/template/` to `solidity/<name>`.
- Edit the `name`, `description`, and `repository.directory` fields in `package.json`, then the README.
- Add Solidity dependencies with pnpm, not `forge install`.
- Put docs in `solidity/<name>/docs`.
- Use custom errors with `revert`. Never use `require`.
- Run `turbo run check test --filter=<name>`.

## New package

- Create `packages/<name>` with `package.json`, and `tsconfig.json` that extends `../../tsconfig.json`.
- Add a `check` script (`ultracite fix --type-aware --type-check`) and a `test` script (`vitest run`).
- Add a `build` script only when the package emits or bundles. Tests import source.
- Scoped `@tunnckocore/*` packages publish to `npm.wgw.lol`. Unscoped packages publish to npmjs.com.
- Every package needs a `repository` field with the monarch URL and its `directory`.
- Every package change needs a Changeset: `pnpm changeset`.

## New app

- Create `apps/<name>` with `package.json`, `alchemy.run.ts`, and `tsconfig.json` that extends the root one.
- Add `check`, `test`, and `deploy:nightly` scripts. Add `deploy:prod` when the app has a separate production stage.
- Add each secret as a Depot secret and to `passThroughEnv` of the deploy tasks in `turbo.json`.
- The app needs no workflow of its own.
- Never run a deploy script locally unless the user asks.

## CI and releases

- CI runs on Depot CI from `.depot/workflows/`. GitHub Actions only publishes unscoped packages, auto-merges Dependabot, and handles `/approve` comments.
- The `ci` workflow runs `check`, `test`, and `build` on pull requests and on `master`.
- A push to `master` publishes `nightly` packages and deploys changed apps to nightly.
- The release pull request (`chore: release packages`) publishes `latest`. The owner merges it by hand.
- Production app deploys run only by hand, with `pnpm run apps:deploy:prod`, and only when the user asks.
- The publishing, registry, and deploy details are in `AGENTS.backup.md`.

## Pull requests

- Use conventional commits. One concern per pull request.
- Open with `gh pr create`, then run `gh pr merge --auto --squash`. Never merge by hand.
- Never enable auto-merge on the release pull request.
- The master ruleset requires `ci / check`, `ci / test`, `ci / build`, 5 approvals of the latest push, and resolved threads. A new push dismisses approvals.
- Greptile does not review on its own. Comment `@greptileai review` to request a review.
- Do not approve a pull request unless the user says so.
- Push to `master` directly only when the user asks.
