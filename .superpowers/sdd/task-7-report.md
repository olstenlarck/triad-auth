# Task 7 Report: Account Sessions And Rate Limits

## Status

Implemented, self-reviewed, and locally verified. The containing commit uses message `feat: finish account session safety`; its SHA is returned in the task handoff.

## Delivered

- Moved `/session/start/:provider`, `/api/me`, consent revocation, and account logout into `accountRoutes`.
- Added session-bound, purpose-bound, one-time CSRF tokens to account inspection, revocation, and logout.
- Restricted logout to `POST`, and applied exact-origin checks before body reads plus the existing form encoding, duplicate-parameter, and 4096-byte body limits to account mutations.
- Rotated browser sessions only after successful GitHub callback branches. Rotation atomically deletes the prior hashed D1 session and inserts a new hashed token with a 30-day expiry.
- Set session cookies with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and a 30-day maximum age. Successful logout deletes both the D1 session row and browser cookie.
- Updated the account UI to submit CSRF-protected revocation and POST logout requests, adopt the rotated CSRF token after revocation, decrement the displayed authorization count, and render the empty state after the final revocation.
- Added `rate_limits(bucket, key_hash, window_start, count)` with a composite primary key and cleanup index.
- Added an atomic fixed-window D1 limiter that hashes every key, caps stored counts at the limit, rolls over at window expiry, and removes prior windows for active buckets.
- Applied per-IP limits to account starts (10/minute), downstream authorization starts (20/minute), device issuance (10/minute), device inspection (30/minute), provider callbacks (30/minute), and device token polling (60/minute).
- Kept authorization-code exchange outside the polling bucket and returns OAuth `slow_down` for limited device polls so device clients preserve protocol behavior.
- Replaced exception-object logging with fixed route labels so database errors, client secrets, provider codes, tokens, and other OAuth artifacts are not emitted.
- Regenerated the CSP script allowlist for the updated account page.

## TDD Evidence

- Account tests failed first because POST logout was absent, account inspection returned no CSRF token, revocation accepted no protected body, the old callback session survived rotation, logout did not clear state, and the UI had no POST logout/count update.
- Limiter tests failed first because `src/rate-limit.ts` was absent, then passed for exact boundary enforcement, capped counts, hashed storage, contention, rollover, and cleanup.
- Route tests failed first at all six intended public boundaries, then passed after limiter placement.
- The log test failed first by observing a synthetic secret and provider artifact in `console.error`, then passed with fixed-label logging.
- Every focused red cycle was followed by the corresponding focused green run before full verification.

## Verification

- `pnpm vitest run test/account.test.ts test/rate-limit.test.ts test/oauth.test.ts test/device.test.ts`: PASS, 4 files and 75 tests.
- `pnpm test`: PASS, 11 files and 127 tests.
- `pnpm typecheck`: PASS, zero TypeScript errors.
- `pnpm build && pnpm build`: PASS, 6 pages built on each run and 3 CSP hashes generated from 6 HTML files.
- A subsequent CSP generation produced the identical file hash, confirming the second build embedded the current allowlist.
- `git diff --check`: PASS, no whitespace errors.

## Self-Review

- Confirmed account mutations reject a non-exact or absent origin before reading the request body.
- Confirmed CSRF values and session tokens are stored only as SHA-256 hashes and are consumed or rotated once.
- Confirmed callback rate limiting occurs before state consumption, preserving retryability after a limited callback.
- Confirmed device polling has enough headroom for the advertised five-second interval and limited polling still produces `slow_down` without affecting authorization-code grants.
- Confirmed fixed-window upserts use one atomic conflict update with `WHERE count < limit` and never increment persisted counts beyond the configured limit.
- Confirmed expired windows are deleted without touching the active window under concurrent requests.
- Confirmed logs contain only fixed route labels and no exception messages.
- Confirmed the account count changes only after successful revocation and reaches the empty state at zero.

## Concerns And Follow-Up

- Rate-limit behavior was verified against the repository's SQLite-backed D1 adapter; deployment smoke testing should also exercise the production D1 binding and Cloudflare-provided `CF-Connecting-IP` header.
- `Secure` cookies are intentionally unconditional. End-to-end account sessions therefore require HTTPS in deployed environments, as specified.
- No live GitHub callback or browser interaction run was possible without deployment credentials and a browser harness. Route, storage, generated CSP, static UI contracts, typecheck, and production build behavior were verified locally.

## Task 7 Review Follow-Up

The review findings were addressed in a separate follow-up commit; its SHA is returned in the task handoff.

### Corrections

- Added a random `triad_pre_auth` cookie for every upstream GitHub session, authorization-code consent, and device-confirmation transaction. The cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to `/callback/github`, and expires after ten minutes.
- Stored only the pre-auth cookie hash in `oauth_transactions`. Callback handling now requires the cookie, hashes and timing-safely compares it before consumption, atomically consumes the matched transaction with `DELETE ... RETURNING`, and clears the cookie after a valid match.
- Added distinct-cookie-jar coverage proving a mismatched browser cannot swap a victim's broker session, contact GitHub, or consume the transaction; the initiating browser can still finish afterward.
- Added corresponding missing/mismatched browser tests for authorization-code consent and device confirmation, including cookie clearing after successful and denied callback paths.
- Reworked the account UI around one race-safe account loader. Superseded loads are aborted and ignored, CSRF tokens are removed from memory before mutation, and every stale-CSRF, API, malformed-response, or network failure reloads account state, reissues CSRF, restores current controls in `finally`, and preserves a visible action error.
- Added explicit `expires_at` values to rate-limit rows and changed cleanup from a per-request per-bucket DELETE to a 1/256 sampled global expired-row DELETE backed by an expiry index.
- Domain-separated `CF-Connecting-IP` with HMAC-SHA-256 under `PAIRWISE_SECRET` before the limiter's fixed-length storage hash. Missing-IP local requests retain the shared `unknown` fallback behavior.
- Preserved all public route limits, authorization-code separation, OAuth device `slow_down`, capped atomic upserts, fixed-window rollover, and sanitized logging.
- Regenerated the CSP script allowlist for the account recovery script.

### Follow-Up TDD Evidence

- Three callback-binding tests failed first because no pre-auth cookie was issued, then passed for session, consent, and device transactions.
- The account session-swap test failed first at cookie issuance, then passed while proving the wrong jar neither called GitHub nor consumed state and the original jar completed normally.
- The account recovery test failed first on every missing loader/token/control marker. A self-review assertion then failed because successful recovery hid the triggering action error; both passed after the final recovery flow.
- Limiter tests failed first because ordinary requests executed a DELETE, forced cleanup was not global, and stored IP hashes were identical to raw SHA-256 across secrets. They passed after sampled global cleanup and secret-bound key derivation.

### Follow-Up Verification

- `pnpm vitest run test/account.test.ts test/oauth.test.ts test/device.test.ts test/rate-limit.test.ts test/security.test.ts test/tokens.test.ts`: PASS, 6 files and 97 tests.
- `pnpm test`: PASS, 11 files and 135 tests.
- `pnpm typecheck`: PASS, zero TypeScript errors.
- `pnpm build && pnpm build`: PASS, 6 pages built on each run and 3 CSP hashes generated from 6 HTML files.
- A subsequent CSP generation produced the identical file hash.
- `git diff --check`: PASS, no whitespace errors.

### Follow-Up Concerns

- SQLite-backed tests verify the exact capped upsert/conditional-delete SQL shape and local contention outcomes, but they do not prove Cloudflare D1's remote concurrency behavior. Concurrent callback consumption and rate-limit boundary tests against the deployed remote D1 binding remain required deployment evidence.
- Live cross-site GitHub callback cookie behavior and multi-tab browser interaction still require an HTTPS browser smoke test with deployment credentials.
- The project still edits the pre-deployment `0001_init.sql`; any environment that already applied this migration needs an additive migration for `browser_binding_hash`, rate-limit `expires_at`, and the cleanup index before deploying this follow-up.
