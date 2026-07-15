# Profile Claims and Device Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all requested profile claims issue and verify correctly, restore the v1 device flow to the demo, and redeploy against a clean one-migration staging database.

**Architecture:** OAuth Provider's first-party ID-token and UserInfo hooks own standard profile claims, while its extension path owns Triad's three custom identity claims. The existing Better Auth session-device plugin powers the restored v1 demo bay. Staging is rebuilt from one consolidated baseline migration rather than carrying transitional migration history.

**Tech Stack:** TypeScript 6, Astro, Better Auth 1.7.0-rc.1, `@better-auth/oauth-provider`, Vite Plus, Cloudflare Workers, D1.

## Global Constraints

- Do not modify `vite.config.ts`.
- Do not modify the landing page.
- Do not add explanatory or disclaimer copy to the device demo.
- Preserve the v1 demo composition and existing visual language.
- Do not add profile backfill or compatibility behavior; staging will be rebuilt cleanly.
- Run `vp run check` and `vp run build` before completion.

---

### Task 1: Correct ID-Token Profile Claim Ownership

**Files:**
- Modify: `src/better-auth/tokens/index.ts`
- Modify: `test/better-auth/tokens-composition.test.ts`

**Interfaces:**
- Consumes: `TokenProfileClaimResolver.resolveProfileClaims(user, scopes)`.
- Produces: `oauthProviderOptions.customIdTokenClaims` and `customUserInfoClaims`, both returning only claims authorized by requested scopes.

- [ ] Add failing tests proving `customIdTokenClaims` returns all requested standard profile claims and identity-only requests do not resolve profile data.
- [ ] Add a failing test proving the ID-token extension returns only `account_sub`, `pairwise_sub`, and `provider_sub`, so standard claim guards cannot suppress profile claims from the first-party hook.
- [ ] Run `vp test test/better-auth/tokens-composition.test.ts` and confirm the new assertions fail.
- [ ] Change the ID-token extension to call `resolveTripleIdentityClaims` and configure `customIdTokenClaims` with `resolveScopedProfileClaims`.
- [ ] Run `vp test test/better-auth/tokens-composition.test.ts` and confirm all tests pass.
- [ ] Commit with `fix: issue scoped profile claims`.

### Task 2: Restore the V1 Device Demo Bay

**Files:**
- Modify: `src/pages/demo/index.astro`
- Modify: `test/ui/ui-source-contract.test.ts`
- Create: `test/ui/demo-device-flow.test.ts`

**Interfaces:**
- Consumes: `POST /api/auth/device/code`, `POST /api/auth/device/token`, and the existing `/device/verify/` page.
- Produces: device ticket rendering, verification-page launch, interval polling, terminal success/error states, and page-lifecycle cancellation.

- [ ] Restore source-contract expectations for the v1 `ONE REQUEST. TWO FLOWS.` composition, browser bay, device bay, ticket, verification link, and start action.
- [ ] Add focused tests for device code formatting and token-poll response classification: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, and successful bearer token.
- [ ] Run the focused UI tests and confirm they fail against the browser-only demo.
- [ ] Restore the v1 demo markup from the pre-refactor page while retaining current browser provider/scope controls and callback flow.
- [ ] Adapt device issuance to JSON `{ client_id: location.origin }` at `/api/auth/device/code` and polling to JSON `{ device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: location.origin }` at `/api/auth/device/token`.
- [ ] Preserve the existing ticket, expiry, polling, abort, BFCache, and reset behavior without adding new device-auth copy.
- [ ] Run the focused UI tests and confirm they pass.
- [ ] Commit with `feat: restore device authorization demo`.

### Task 3: Consolidate the Baseline Schema

**Files:**
- Modify: `migrations/0001_better-auth.sql`
- Delete: `migrations/0002_disclosures_device.sql`
- Modify: schema migration tests under `test/schema/` if exact migration inventory is asserted.

**Interfaces:**
- Produces: one baseline migration containing the five nullable `profile*` user columns and complete `deviceCode` table with its indexes and foreign key.

- [ ] Add or update the migration contract test to require profile columns and `deviceCode` in `0001_better-auth.sql` and exactly one migration file.
- [ ] Run the focused schema test and confirm it fails.
- [ ] Fold all statements from `0002_disclosures_device.sql` into the original `user` definition and baseline table/index ordering, then delete `0002`.
- [ ] Run the focused schema test and confirm it passes.
- [ ] Commit with `chore: consolidate better auth schema`.

### Task 4: Verify and Rebuild Staging

**Files:**
- Modify: `wrangler.toml` with the replacement staging D1 UUID.

**Interfaces:**
- Consumes: the consolidated baseline migration and existing staging Worker secrets.
- Produces: a clean staging database and deployed Worker.

- [ ] Run `vp run check` and require zero formatting, lint, type, or test failures.
- [ ] Run `vp run build` and require a successful Astro/Cloudflare build.
- [ ] Delete only the D1 database named `triad-better-auth-staging`, create it again, and replace the staging `database_id` in `wrangler.toml`.
- [ ] Run `vp run db:migrate:staging` and verify only `0001_better-auth.sql` is applied.
- [ ] Run `vp run deploy:staging` and record the new deployment version.
- [ ] Verify discovery advertises `openid email handle name avatar`, DCR accepts those scopes, and device code issuance returns the configured verification URI.
- [ ] Complete a browser Google flow with all optional scopes and verify the returned signed ID token contains all requested standard claims plus the three Triad identity claims.
- [ ] Complete device issuance, browser approval, and polling, and verify polling returns an authorized bearer session.
- [ ] Commit `wrangler.toml` with `chore: rebuild staging database` and confirm the worktree is clean.
