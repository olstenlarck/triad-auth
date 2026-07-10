# Task 6 Report: Same-Origin Demo And Transactional UI

## Status

Implemented and locally verified. The containing commit uses message `feat: add interactive broker demos`; its SHA is returned in the task handoff.

## Delivered

- Added `/demo/` with a complete browser authorization-code flow using a 64-byte PKCE verifier, S256 challenge, random state, and exactly two `sessionStorage` entries for verifier/state.
- Added `/demo/callback/` with state rejection before any token or metadata request, one-time code exchange, and recovery states for denial, malformed callbacks, exchange failure, and verification failure.
- Added a complete device demo that requests a grant, presents the user code and exact verification link, polls at the advertised interval, adds five seconds on `slow_down`, and stops on success, denial, expiry, unknown terminal errors, or page exit.
- Added shared browser protocol code backed by JOSE. It fetches discovery and JWKS, selects the matching EC P-256 ES256 signing key, imports it through JOSE, verifies signature/issuer/audience/expiry, and validates the three identity claims before rendering.
- Added verified claim ledgers for `pairwise_sub`, `account_sub`, and `provider_sub`, with explicit app-scoped, broker-global, and GitHub-global correlation semantics.
- Fixed consent approve/deny requests to submit the fetched transaction-bound CSRF token as form-encoded data.
- Fixed device verification to submit its fetched grant-bound CSRF token and removed provider selection in favor of the only supported provider, GitHub.
- Removed Google/X controls and claims from the global shell, landing page, account page, consent page, and device page. Added demo navigation and retained source/discovery access.
- Extended the established black-box switchboard system with hard-rule demo bays, text-plus-shape statuses, 48px controls, keyboard focus, mobile stacking, reduced-motion behavior, loading/error/success states, and selectable/overflow-safe identifiers.
- Replaced the initial `local-dev` client with `triad-demo`, exact local redirect `http://localhost:8787/demo/callback/`, and GitHub-only provider allowlists. `triad-account` remains the broker's internal session client.
- Regenerated the CSP script hash allowlist through the production build.

## TDD Evidence

- Demo route assertion failed first because `dist/demo/index.html` did not exist, then passed after the routes were added.
- Migration assertion failed first on `local-dev`, port 3000, and the three-provider seed, then passed with the exact `triad-demo` row.
- Browser protocol tests failed first because the module/functions did not exist, then passed for PKCE, real ES256 JOSE verification, invalid key/algorithm/issuer/audience/expiry/claims, and device polling decisions.
- CSRF and GitHub-only UI assertions failed first against the previous pages, then passed after the transactional and copy changes.
- Self-review found a stale device action label on local expiry. Its regression assertion failed first, then passed after both expiry branches restored `START NEW DEVICE FLOW`.

## Verification

Executed after the final self-review correction:

- `pnpm build`: PASS. Astro built 6 pages; CSP generator produced 3 hashes from 6 HTML files.
- `pnpm vitest run test/ui.test.ts`: PASS, 5 tests.
- `pnpm test`: PASS, 9 files and 107 tests.
- `pnpm typecheck`: PASS, zero TypeScript errors.
- `git diff --check`: PASS, no whitespace errors.

## Self-Review

- Confirmed callback state comparison appears before the first token/discovery `fetch`.
- Confirmed only verifier and state are written to `sessionStorage`.
- Confirmed the browser bundle contains JOSE/Web Crypto verification code and no `node:crypto` dependency.
- Confirmed device polling honors server interval, backs off by five seconds, and cancels on terminal/local states.
- Confirmed consent and device mutation bodies include the fetched `csrf_token` with form encoding.
- Confirmed the initial migration contains the exact local callback including its trailing slash.
- Confirmed source UI contains no Google/X provider controls or em dash characters.
- Confirmed mobile rules stack demo bays and verified claim rows without changing the existing visual language.

## Concerns And Deployment Follow-Up

- The production `triad-demo` redirect URI is intentionally not invented in this task. Replace/finalize the local URI during deployment, then apply the final production migration/configuration before live smoke testing.
- This harness has no browser screenshot or interaction tool, so visual desktop/mobile inspection and an end-to-end live GitHub sign-in were not run here. Static production builds, source contracts, JOSE tests, route tests, and responsive CSS were verified. Live browser smoke testing still requires a running local or deployed broker with GitHub credentials.

## Task 6 Review Follow-Up

The review findings were addressed in a separate follow-up commit; its SHA is returned in the task handoff.

### Corrections

- Changed successful `POST /device/verify` responses from a cross-origin 302 to same-origin JSON containing `redirect_to`. The page now prevents native submission before validation, sends the existing form-encoded user code/provider/CSRF values with `fetch`, validates the JSON response, and calls `location.assign` itself. CSP `form-action 'self'` is no longer involved in the GitHub navigation.
- Preserved server-side exact-origin validation before body parsing, bounded form parsing, duplicate-parameter rejection, GitHub provider allowlist validation, purpose-bound one-time CSRF consumption, and OAuth transaction creation.
- Added a device-flow `stopped` flag and `AbortController`. The signal now covers discovery, device issuance, token polling, and discovery/JWKS requests during token verification. `pagehide` clears the timer and aborts the controller; stopped checks after asynchronous boundaries and before scheduling prevent post-hide polling or UI updates.
- Corrected consent loading copy so approve changes only to `OPENING GITHUB` and deny changes only to `DENYING REQUEST`. Every failure restores both canonical labels, disables the stale transaction controls, and reveals a stable `RETURN TO DEMO` recovery route.

### Follow-Up TDD Evidence

- The device route test failed first on the old `[302, 403]` result and passed after the successful response became `[200, 403]` with a GitHub `redirect_to` value.
- UI assertions failed first because submit prevention occurred only after the CSRF branch, no same-origin verification fetch existed, no stopped/controller lifecycle existed, and consent had no per-action control or recovery route.
- Abort propagation failed first because discovery and JWKS fetches received no signal, then passed after the shared protocol helper accepted and forwarded one `AbortSignal`.

### Follow-Up Verification

- `pnpm vitest run test/ui.test.ts test/device.test.ts test/oauth.test.ts test/demo-protocol.test.ts`: PASS, 4 files and 84 tests.
- `pnpm build`: PASS, 6 pages built and 3 CSP script hashes regenerated from 6 HTML files.
- `pnpm test`: PASS, 9 files and 111 tests.
- `pnpm typecheck`: PASS, zero TypeScript errors.
- `git diff --check`: PASS, no whitespace errors.

### Follow-Up Concerns

- Production redirect finalization and live browser/GitHub smoke testing remain deployment work. README and PRODUCT synchronization remains explicitly assigned to Task 8.
