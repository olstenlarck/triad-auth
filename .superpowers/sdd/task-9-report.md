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

## Historical concerns resolved in Phase 4

- Locked `workerd@1.20260702.1` rejected the repository's former `2026-07-10` compatibility date. Phase 4 aligns the committed date to the runtime-supported `2026-07-09`.
- Rebuilding `dist` while Wrangler watched it temporarily invalidated the local assets binding. Restarting Wrangler restored all routes. This affected validation setup, not the built output or deploy dry-run.
- Local device API requests returned HTTP 500 because required local `PAIRWISE_SECRET` configuration was absent. Phase 4 proves issuance succeeds under valid ignored local configuration.
- Chromium's automatic favicon request returned 404. Phase 4 adds and links a local SVG favicon that returns 200.

## Commit

Subject: `fix: validate responsive broker UI`

## Debug investigation

Investigation date: 2026-07-10. Scope was systematic-debugging Phases 1-3 only. No application code, dependency lock, or runtime configuration was modified.

### Failure 1: local `POST /device/code` returns 500

#### Reproduction

The existing local database was current:

```text
$ pnpm db:local
No migrations to apply!
```

The local configuration preflight identified all four absent secrets:

```text
$ pnpm check:config
Missing required configuration: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SIGNING_PRIVATE_JWK, PAIRWISE_SECRET
```

The Worker was started with debug logging and only the compatibility-date override needed by the locked runtime:

```text
$ pnpm wrangler dev --local --compatibility-date 2026-07-09 --log-level debug > /tmp/opencode/task9-device-debug.log 2>&1
```

Wrangler reported only `DB`, `ASSETS`, and `ISSUER` bindings. It explicitly logged `local dev variables file not found at ".dev.vars"`; no `PAIRWISE_SECRET` binding was present.

The valid request was:

```text
$ curl --include --silent --show-error --request POST \
    http://localhost:8787/device/code \
    --header "content-type: application/x-www-form-urlencoded" \
    --data "client_id=triad-demo&provider=github&scope=openid"

HTTP/1.1 500 Internal Server Error
{"error":"server_error"}
```

The complete available Worker log for the request was:

```text
[ERROR] device route failed
[wrangler-ProxyWorker:info] POST /device/code 500 Internal Server Error (5ms)
```

No original exception stack is available from the Worker because `src/routes/device.ts` registers `onError((_error, c) => ...)` and logs only the fixed string `device route failed`. Wrangler debug output confirms a `Runtime.consoleAPICalled` stack exists internally but serializes it as `{ callFrames: [Array] }`; the exception object itself was discarded before logging.

#### Request trace and D1 evidence

Source order in `src/routes/device.ts` is:

1. `enforceRequestRateLimit(..., c.env.PAIRWISE_SECRET, "device-issue", 10)` at lines 34-37.
2. Form parsing and validation at lines 38-52.
3. `getClient` and `validateClient` at lines 53-59.
4. `INSERT OR IGNORE INTO device_grants` at lines 61-81.

Actual D1 state was inspected with:

```text
$ pnpm wrangler d1 execute triad-auth --local --json --command \
  "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('clients', 'rate_limits', 'device_grants') ORDER BY name;
   SELECT client_id, name, redirect_uris, providers FROM clients ORDER BY client_id;
   SELECT 'rate_limits' AS table_name, COUNT(*) AS row_count FROM rate_limits
   UNION ALL SELECT 'device_grants', COUNT(*) FROM device_grants;"
```

Evidence:

- `clients`, `rate_limits`, and `device_grants` exactly match migration `0001_init.sql`.
- Foreign keys are enabled and `device_grants.client_id` references `clients.client_id`.
- `triad-demo` exists with provider JSON `["github"]` and the expected local callback.
- After the failing request, `rate_limits` had 0 rows and `device_grants` had 0 rows. The request therefore failed inside the limiter before the client lookup or grant insert.

The limiter hashes a present `cf-connecting-ip` with `hmacSha256(secret, ...)`. With the absent binding, `TextEncoder.encode(undefined)` produces a zero-length key. The exact lower-level operation was reproduced without changing source:

```text
$ node -e "const e=new TextEncoder(); crypto.subtle.importKey('raw',e.encode(undefined),{name:'HMAC',hash:'SHA-256'},false,['sign']).catch(error=>{console.error(error.stack); process.exitCode=1})"

DataError: Zero-length key is not supported
    at Object.macImportKey (node:internal/crypto/mac:195:11)
    at SubtleCrypto.importKeySync (node:internal/crypto/webcrypto:782:10)
    at SubtleCrypto.importKey (node:internal/crypto/webcrypto:893:10)
```

#### Minimal hypothesis test

Only one runtime variable was changed, using a synthetic non-secret value:

```text
$ pnpm wrangler dev --local --compatibility-date 2026-07-09 --log-level debug \
    --var "PAIRWISE_SECRET:pppppppppppppppppppppppppppppppp"
$ curl --include --silent --show-error --request POST \
    http://localhost:8787/device/code \
    --header "content-type: application/x-www-form-urlencoded" \
    --data "client_id=triad-demo&provider=github&scope=openid"

HTTP/1.1 200 OK
{"device_code":"...","user_code":"4B3W-EF4M",...,"expires_in":600,"interval":5}
```

Wrangler now listed `env.PAIRWISE_SECRET ("(hidden)")`. D1 contained one `device-issue` limiter row with count 1 and a 60-second window, plus one pending `triad-demo` grant with a 600-second TTL and 5-second interval. This proves limiter completion, successful client lookup/validation, and successful grant insertion.

**Root-cause hypothesis:** `PAIRWISE_SECRET` is absent from local Worker bindings. Wrangler supplies a client IP, so the first route operation attempts an HMAC with a zero-length key and throws `DataError` before parsing the valid form or touching D1. The route error handler hides that exception behind the generic 500. The single-variable test confirms this hypothesis.

**Minimal test that would prove a fix:** start the Worker with the intended local configuration and no CLI `--var`; require `pnpm check:config` to pass, require the valid POST above to return 200, then assert exactly one `device-issue` limiter row and one pending `triad-demo` grant. A negative startup/config test should also prove that an absent or empty `PAIRWISE_SECRET` fails before the Worker serves requests, rather than failing inside a route.

### Failure 2: compatibility date `2026-07-10` is rejected

#### Installed and locked dependency evidence

```text
$ pnpm --version
11.10.0
$ pnpm wrangler --version
4.107.1
$ node_modules/.pnpm/workerd@1.20260702.1/node_modules/workerd/bin/workerd --version
workerd 2026-07-02
$ pnpm why wrangler && pnpm why workerd && pnpm why miniflare
wrangler@4.107.1
workerd@1.20260702.1
miniflare@4.20260702.0
```

`package.json` permits `wrangler: ^4.24.3`, but `pnpm-lock.yaml` pins Wrangler 4.107.1. Wrangler 4.107.1 then exact-pins `workerd: 1.20260702.1` and `miniflare: 4.20260702.0`; Miniflare exact-pins the same workerd. The broad optional workerd peer range in `@cloudflare/unenv-preset` does not control this direct exact dependency. `@cloudflare/workers-types@5.20260710.1` supplies types only and does not select the local runtime binary.

The exact failing command and stack were captured in `/tmp/opencode/task9-compat-debug.log`:

```text
$ pnpm wrangler dev --local --log-level debug

service core:user:triad-auth-broker: This Worker requires compatibility date "2026-07-10", but the newest date supported by this server binary is "2026-07-09".
MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start.
    at StartupLogBuffer.handleStartupFailure (.../miniflare@4.20260702.0/.../index.js:71301:13)
    at Runtime.updateConfig (.../miniflare@4.20260702.0/.../index.js:71391:24)
    at async #assembleAndUpdateConfig (.../miniflare@4.20260702.0/.../index.js:91402:30)
    at async #waitForReady (.../miniflare@4.20260702.0/.../index.js:91523:5)
    at async #onBundleComplete (.../wrangler@4.107.1.../cli.js:363333:33)
```

#### Resolution evidence

Registry metadata and current package metadata were inspected with:

```text
$ pnpm view wrangler@4.107.1 version dependencies.workerd dependencies.miniflare --json
{"version":"4.107.1","dependencies.workerd":"1.20260702.1","dependencies.miniflare":"4.20260702.0"}

$ pnpm view wrangler@4.110.0 version dependencies.workerd dependencies.miniflare --json
{"version":"4.110.0","dependencies.workerd":"1.20260708.1","dependencies.miniflare":"4.20260708.1"}
```

Publish timestamps were:

```text
wrangler 4.107.1      2026-07-07T18:11:02.682Z
wrangler 4.110.0      2026-07-09T18:25:09.429Z
workerd 1.20260702.1  2026-07-02T01:36:24.728Z
workerd 1.20260708.1  2026-07-08T01:09:34.145Z
workerd 1.20260710.1  2026-07-10T01:13:12.214Z
```

The initial lockfile commit was created at `2026-07-10 04:59:00 +0000`, about 10.5 hours after Wrangler 4.110.0 was published. pnpm 11's documented built-in `minimumReleaseAge` default is 1440 minutes. Because 4.110.0 was less than one day old, resolution selected the older eligible 4.107.1 even though both satisfy `^4.24.3`. Subsequent installs prefer the satisfying lockfile and do not re-resolve the range.

#### Minimal hypothesis test

A temporary latest resolution was run from pnpm's `dlx` cache without changing tracked files:

```text
$ pnpm dlx wrangler@4.110.0 --version
4.110.0
$ pnpm dlx workerd@1.20260708.1 --version
workerd 2026-07-08
$ pnpm dlx wrangler@4.110.0 dev --local --port 8790 --log-level debug
[wrangler-ProxyWorker:info] Ready on http://localhost:8790
$ curl --fail --head http://localhost:8790/
HTTP/1.1 200 OK
```

Wrangler 4.110.0 exact-resolved workerd 1.20260708.1 and accepted `wrangler.toml`'s `2026-07-10` date without an override. `git status --short` remained empty after the temporary dependency tests.

**Root-cause hypothesis:** the package range is not the runtime actually executed. pnpm 11's one-day release-age policy selected Wrangler 4.107.1 when the lockfile was created, the lockfile retained it, and that Wrangler exact-pins workerd 1.20260702.1, whose binary supports compatibility dates only through `2026-07-09`. The transient 4.110.0 test confirms that a newer eligible runtime accepts `2026-07-10`.

**Minimal test that would prove a fix:** with the repository's final lockfile and no `--compatibility-date` override, run `pnpm wrangler dev --local --log-level debug`, wait for `Ready`, and require `curl --fail --head http://localhost:8787/` to return 200. Also assert `pnpm why wrangler workerd miniflare` resolves the intended versions and that logs contain neither `newest date supported` nor `ERR_RUNTIME_FAILURE`.

Both reproduction servers were terminated after the tests.

## Phase 4 follow-up

### Compatibility-date TDD

The regression binds `wrangler.toml` to the maximum date supported by the exact workerd version in `pnpm-lock.yaml`.

Red phase:

```text
$ pnpm vitest run test/config.test.ts
1 failed, 6 passed
expected false to be true
```

The failure proved `2026-07-10` exceeded locked `workerd@1.20260702.1`'s observed `2026-07-09` maximum.

Green phase:

```text
$ pnpm vitest run test/config.test.ts
1 test file passed, 7 tests passed
```

Only `wrangler.toml` changed, from `2026-07-10` to `2026-07-09`. Locked Wrangler 4.107.1 then reached `Ready` without a `--compatibility-date` override and served `HEAD /` with 200 from a fresh migrated persistence directory.

### Favicon TDD

Red phase:

```text
$ pnpm vitest run test/ui.test.ts
1 failed, 10 passed
expected public/favicon.svg to exist
```

Green phase:

```text
$ pnpm vitest run test/ui.test.ts
1 test file passed, 11 tests passed
```

`public/favicon.svg` uses hard-edged switchboard geometry and the existing near-black, ink, and olive OKLCH colors. `Shell.astro` links it as `image/svg+xml`.

### Valid local device configuration

An ignored mode-600 `.dev.vars` was generated for validation with:

- Empty `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` fields reserved for the user.
- A freshly generated ES256 EC P-256 private JWK.
- A freshly generated 64-character pairwise secret.

`git check-ignore` confirmed `.dev.vars` is ignored. `pnpm check:config` reported only the intentionally empty GitHub fields, proving the generated signing and pairwise values are valid without printing them.

The isolated local database was migrated, then locked Wrangler was started without a date override. The same request that previously returned 500 now returned 200:

```text
$ curl --request POST http://localhost:8787/device/code \
    --header "content-type: application/x-www-form-urlencoded" \
    --data "client_id=triad-demo&provider=github&scope=openid"

HTTP/1.1 200 OK
```

D1 changed from zero limiter/grant rows to:

- `rate_limits`: bucket `device-issue`, count 1, 60-second window, 43-character key hash.
- `device_grants`: client `triad-demo`, status `pending`, 5-second interval, 600-second TTL, 43-character device hash, 8-character normalized user code.

This resolves the prior 500 as missing required local configuration. No GitHub provider request was made.

### Browser and build verification

- `agent-browser` desktop `1440x900` on `/`: expected accessibility snapshot, favicon link present, no overflow, empty console and page-error buffers.
- `agent-browser` mobile `390x844` on `/demo/`: expected accessibility snapshot, favicon link present, no overflow, empty console and page-error buffers.
- Worker log: `GET /favicon.svg 200 OK` on both representative pages.
- Screenshots: `/tmp/opencode/triad-auth-task9-shots/after/phase4-home-desktop.png` and `phase4-demo-mobile.png`.
- `pnpm check`: 12 test files, 148 tests, six Astro routes, three CSP hashes, 26 static assets, and Wrangler deploy dry-run passed.

### Local-only concern

The earlier temporary Wrangler 4.110.0 experiment upgraded the ignored default Miniflare `_cf_ALARM` table. Locked workerd then rejected that local internal schema. Phase 4 used a fresh migrated persistence directory under `/tmp/opencode` and did not delete the existing ignored local state without approval. Repository output and the isolated locked-runtime validation are unaffected.

Phase 4 did not update Wrangler, workerd, Miniflare, `pnpm-lock.yaml`, or pnpm supply-chain settings.

### Phase 4 commit

Subject: `fix: align local worker validation`
