# Task 9 visual validation

Validated on 2026-07-10 against the local Worker at `http://localhost:8787` with `agent-browser` 0.26.0.

## Environment

- Required setup completed with `pnpm db:local` and `pnpm build`.
- `pnpm wrangler dev --local` initially failed because `wrangler.toml` uses compatibility date `2026-07-10`, while locked `workerd@1.20260702.1` supports through `2026-07-09`.
- Browser validation used the local-only equivalent `pnpm wrangler dev --local --compatibility-date 2026-07-09`. No deployment configuration was changed.
- Viewports: desktop `1440x900`; mobile `390x844`.
- Normal and `prefers-reduced-motion: reduce` media states were tested at both sizes.

## Audit health

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Accessibility | 4/4 | Semantic snapshots, complete Tab sequences, visible 3px focus outlines, 44px enabled targets, labeled forms, announced errors. |
| Performance | 3/4 | Lean static pages, local fonts, no layout-property animation, no observed layout shift; no profiler run. |
| Responsive design | 4/4 | All routes checked at both required viewports with no page-level horizontal overflow after fixes. |
| Theming | 4/4 | Existing OKLCH tokens retained; no new authored colors or theme drift. |
| Anti-patterns | 4/4 | Square ruled switchboard composition retained; no gradients, glass, rounded card grids, or generic redesign. |
| **Total** | **19/20** | **Excellent** |

**Anti-pattern verdict:** Pass. The interface remains a distinctive black-box identity switchboard rather than a generic generated dashboard.

## Route matrix

All final rows had an empty `agent-browser console` buffer and no `agent-browser errors`. Accessibility snapshots exposed the expected headings, landmarks, labels, controls, disabled states, and recovery links.

| Route | Rendered state | Desktop | Mobile | Final overflow |
| --- | --- | --- | --- | --- |
| `/` | Landing page and protocol proof | `after/home-desktop.png` | `after/home-mobile.png` | None; the code sample scrolls inside its labeled region. |
| `/demo/` | Both broker flow bays ready | `after/demo-desktop.png` | `after/demo-mobile.png` | None |
| `/demo/callback/` | Missing-state recovery error | `after/callback-desktop.png` | `after/callback-mobile.png` | None; mobile heading `scrollWidth` equals `clientWidth` at 311px. |
| `/consent/` | Missing-ticket recovery error | `after/consent-desktop.png` | `after/consent-mobile.png` | None |
| `/device/verify/` | Empty device-code form | `after/device-desktop.png` | `after/device-mobile.png` | None |
| `/me/` | Signed-out account state | `after/me-desktop.png` | `after/me-mobile.png` | None |

Screenshots were captured under `/tmp/opencode/triad-auth-task9-shots/`. The `before/` and `after/` directories contain the 12 required route/viewport captures; additional files record exercised error states.

## Findings and corrections

### P1: consent heading caused mobile horizontal scrolling

- **Observed:** At `/consent/`, `390x844`, `CONNECTION.` measured 438px wide and pushed the document to 470px.
- **Impact:** Content clipped at the right edge and introduced a horizontal scrollbar.
- **Correction:** Added a narrow-screen, copy-specific font cap for `#consent-title` in `src/styles/global.css`.
- **Result:** The title fits, document horizontal overflow is false, and the switchboard display treatment remains intact.

### P2: callback heading painted outside its content column

- **Observed:** At `/demo/callback/`, `390x844`, the heading had a 335px scroll width inside a 311px content box. It did not expand the page but visibly entered the gutter.
- **Impact:** The final glyph appeared clipped against the viewport edge.
- **Correction:** Added a separate narrow-screen cap for `#callback-title`, retaining more scale than the longer consent title.
- **Result:** Heading `scrollWidth` and `clientWidth` both measure 311px.

### P2: small standalone and header touch targets

- **Observed:** Mobile header links measured 19px high, the wordmark 26px high, `DEMO` 29px wide, and the standalone device-verification link 17px high.
- **Impact:** Small targets make touch use less reliable even though keyboard focus remained visible.
- **Correction:** Shared wordmark, header-link, and `.text-link` hit areas now have a 44px minimum width and height.
- **Result:** The final route matrix reports no enabled interactive target below `44x44`.

Static regression assertions for the responsive caps and target dimensions were added to `test/ui.test.ts`. Each assertion was observed failing before its CSS correction and passing afterward.

## Keyboard and motion

- Tabbed through every enabled control on all six routes at both viewports.
- Mobile navigation correctly omits the CSS-hidden `DISCOVERY` and `ME` links from the Tab order.
- Every focused control reported `outline: oklch(0.66 0.16 250) solid 3px` with a `4px` offset.
- The skip link becomes visible first, updates the fragment to `#content`, and makes the next Tab land on the first control in main content.
- Callback errors receive programmatic focus; consent and device errors use alert/live semantics.
- Under reduced motion, every route reported `matchMedia(...).matches === true`, zero active animations, `scroll-behavior: auto`, and `0.01ms` control transitions. The callback status pulse reported `animation-name: none`.

## Safe interactions

- Entered invalid device code `ABCD-2345`: the form cleared busy state, kept submission disabled, exposed `That device code is invalid or expired.`, and announced an error status without overflow.
- Started the demo's local device-code request without following any provider redirect: the local API returned an error, and the UI restored the enabled `START DEVICE FLOW` action with a visible error status.
- Used callback and consent `RETURN TO DEMO` recovery links and confirmed navigation to `/demo/`.
- Did not activate GitHub sign-in, consent approval, account sign-in, or any external provider interaction.

## Residual observations

- Local device API requests returned HTTP 500 in this environment after the migration, while the inspected UI recovery states behaved correctly. This is outside the Task 9 UI/accessibility correction scope and no provider flow was attempted.
- Chromium requested `/favicon.ico`, which returned 404. This produced no browser console or page error and has no P0/P1/P2 UI or accessibility impact.
