# Final Multi-Provider Fix Report

Date: 2026-07-10

## Outcome

All four final-review findings were implemented in one TDD wave while preserving the existing routes and privacy contract.

## Changes

1. Consent retention now states that claims become non-exchangeable at expiry and that physical encrypted-row deletion is bounded, traffic-driven cleanup that can occur later.
2. Consent and device disclosure labels now say `EMAIL + VERIFICATION STATUS` while continuing to disclose `email + email_verified` and preserve both boolean values.
3. OIDC discovery now advertises canonical ordered `scopes_supported` and `claims_supported` arrays.
4. `issueIdToken` now rejects every `provider_sub` that does not exactly match `prv_(google|github|twitter)_[A-Za-z0-9_-]{22}`. Direct fixtures were updated to conform, and raw plus malformed rejection cases were added.
5. The generated CSP script hash was refreshed after the consent inline script changed.

## TDD Evidence

### RED

Command:

```text
pnpm vitest run test/ui.test.ts test/oauth.test.ts test/tokens.test.ts
```

Observed: 9 expected failures and 74 passes. Failures covered missing retention copy, both stale disclosure labels, absent discovery arrays, and six malformed provider-subject cases that incorrectly produced tokens.

### GREEN

Command:

```text
pnpm vitest run test/ui.test.ts test/oauth.test.ts test/tokens.test.ts
```

Observed: 3 test files passed, 83 tests passed.

The first full-suite run then exposed two approved device-grant fixtures containing legacy raw subjects. Those fixtures and all other non-negative direct fixtures were updated to conform to the signing boundary. The rerun passed.

## Verification

- Focused tests: 83/83 passed.
- Full suite: 253/253 passed across 14 files.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; six pages built and one CSP hash generated.
- `pnpm check`: passed, including typecheck, build, 253 tests, and Wrangler deploy dry-run.
- `git diff --check`: passed.

## Self-Review

- Exact discovery ordering matches the requested canonical lists.
- Validation is anchored and permits only Google, GitHub, or Twitter with exactly 22 base64url characters.
- Tests cover raw, unsupported-provider, missing-prefix, short, long, and invalid-character subjects.
- Tests explicitly preserve `email_verified: true` and `email_verified: false`.
- Remaining raw `github:42` test references are intentional rejection or non-disclosure assertions.
- No routes, endpoint behavior, one-time exchange semantics, or privacy identifiers were changed.

## Concerns

None. The stricter signing boundary intentionally rejects any stale malformed database fixture or row rather than issuing a non-contract token.
