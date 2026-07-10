# Task 9 Report

## Status

Complete. All six public routes were inspected with `agent-browser` at `1440x900` and `390x844`; observed P1/P2 responsive and touch-target defects were corrected without changing the switchboard design.

## Implementation

- Added 44px minimum width and height to the wordmark, header navigation links, and standalone text links.
- Added copy-specific mobile display caps for the long consent and callback headings. The landing hero and other valid product headings retain their existing scale.
- Added static UI regression assertions for both responsive heading caps and minimum link target dimensions.
- Added `docs/validation/visual-check.md` with the route matrix, audit score, screenshots, keyboard checks, reduced-motion evidence, interactions, findings, and residual observations.

## Test-Driven Development

Initial red phase:

```text
pnpm vitest run test/ui.test.ts
2 failed, 8 passed
```

The missing consent mobile cap and 44px target-height rule both failed as expected.

Touch-width red phase:

```text
pnpm vitest run test/ui.test.ts
1 failed, 9 passed
```

The extended assertion proved the 29px-wide mobile `DEMO` link still lacked a minimum width.

Callback-heading red phase:

```text
pnpm vitest run test/ui.test.ts
1 failed, 9 passed
```

The added callback assertion failed after browser measurement found a 335px text line inside a 311px heading box.

Green phase:

```text
pnpm vitest run test/ui.test.ts
1 test file passed, 10 tests passed
```

## Browser Evidence

- Required routes: `/`, `/demo/`, `/demo/callback/`, `/consent/`, `/device/verify/`, `/me/`.
- Required viewports: `1440x900` and `390x844`.
- Captures: `/tmp/opencode/triad-auth-task9-shots/before/` and `/tmp/opencode/triad-auth-task9-shots/after/`, including 12 final route/viewport screenshots and additional exercised error-state screenshots.
- Final matrix: no page-level horizontal overflow, no enabled target below `44x44`, no browser console output, and no page errors.
- Consent before/after: document width changed from 470px to 375px at the mobile viewport.
- Callback before/after: heading scroll width changed from 335px to 311px, matching its 311px client width.
- Complete desktop and mobile Tab sequences exposed the expected controls. Every focused control reported a 3px secondary outline with a 4px offset.
- The skip link set `#content` as the sequential focus start; the next Tab landed on the first main-content control.
- Reduced-motion emulation on every route and viewport reported zero active animations, automatic scrolling, 0.01ms transitions, and no callback status pulse.
- Safe interactions exercised invalid device-code recovery, demo device-request error recovery, and callback/consent return navigation. No provider redirect or destructive account action was activated.
- Both named `agent-browser` sessions and the local Worker process were closed after validation.

## Verification

- Baseline `pnpm check`: 12 test files and 144 tests passed; six Astro routes built; three CSP hashes generated; Wrangler deploy dry-run passed.
- Final `pnpm check`: 12 test files and 146 tests passed; six Astro routes built; three CSP hashes generated; Wrangler deploy dry-run passed.
- `git diff --check` passed.
- Self-review found only scoped changes in `src/styles/global.css`, `test/ui.test.ts`, `docs/validation/visual-check.md`, and this report.

## Concerns

- Locked `workerd@1.20260702.1` rejected the repository's `2026-07-10` compatibility date. Validation used `pnpm wrangler dev --local --compatibility-date 2026-07-09`; no repository config was changed.
- Rebuilding `dist` while Wrangler watched it temporarily invalidated the local assets binding. Restarting Wrangler restored all routes. This affected validation setup, not the built output or deploy dry-run.
- Local device API requests returned HTTP 500 after migration. The audited UI handled both failures correctly and exposed recovery actions; backend diagnosis is outside Task 9's UI/accessibility scope.
- Chromium's automatic `/favicon.ico` request returned 404 without producing browser console or page errors. This is P3 and was not changed.

## Commit

Subject: `fix: validate responsive broker UI`
