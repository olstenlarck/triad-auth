# Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Triad's copy and consent UI, simplify opaque IDs, and apply the repository clean-code rules before deploying.

**Architecture:** Keep the existing Hono routes and Astro surfaces. Add one typed scope-subset helper at the protocol boundary, use it from both browser and device consent, and share disclosure-control rendering between both pages. Derived identifiers change format without a database migration.

**Tech Stack:** TypeScript 7, Hono, Astro 7, D1, Vitest, Wrangler, Prettier.

## Global Constraints

- The core identity claims remain fixed behind `openid`; profile claims are user-selectable and default off.
- New subjects use `ps_<32 lowercase hex>` and `pid_<provider>_<32 lowercase hex>`.
- Keep `subject_types_supported: ["pairwise"]`, scope `avatar`, and claim `picture`.
- Retain WCAG 2.2 AA behavior, keyboard focus, reduced motion, and responsive layouts.
- Follow `AGENTS.md`: clear names, early returns, focused functions, narrow types, and no unrelated compatibility code.
- Do not enable Twitter without a complete credential pair.

---

### Task 1: Compact opaque subjects

**Files:**

- Modify: `src/crypto.ts`
- Modify: `src/tokens.ts`
- Test: `test/identity.test.ts`
- Test: `test/tokens.test.ts`
- Test: fixture strings in `test/**/*.test.ts`

**Interfaces:**

- Produces: `pairwiseSubject(secret, accountId, clientId): Promise<string>` returning `ps_<hex>`.
- Produces: `providerSubject(secret, provider, providerUserId): Promise<string>` returning `pid_<provider>_<hex>`.

- [ ] **Step 1: Update subject tests to require lowercase hexadecimal bodies**

```ts
expect(await pairwiseSubject(secret, "acct_a", "client_a")).toMatch(/^ps_[0-9a-f]{32}$/);
expect(await providerSubject(secret, "github", "277398031")).toMatch(/^pid_github_[0-9a-f]{32}$/);
```

- [ ] **Step 2: Run the focused tests and confirm old base64url output fails**

Run: `pnpm test -- test/identity.test.ts test/tokens.test.ts`

Expected: failures referencing `prv_` and the old provider-subject validation regex.

- [ ] **Step 3: Add explicit HMAC bytes and hexadecimal encoding**

```ts
function hexadecimal(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Bytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function pairwiseSubject(secret: string, accountId: string, clientId: string): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `${accountId}\0${clientId}`);
  return `ps_${hexadecimal(digest.slice(0, 16))}`;
}
```

Use the same 16-byte hexadecimal body for `pid_${provider}_...`; retain `hmacSha256()` for callers that require base64url hashes.

- [ ] **Step 4: Update token validation and all fixed fixtures**

```ts
if (!/^pid_(google|github|twitter)_[0-9a-f]{32}$/.test(providerSub)) {
  throw new Error("provider_sub must be an opaque Triad provider subject");
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- test/identity.test.ts test/tokens.test.ts test/demo-protocol.test.ts`

Expected: all focused tests pass.

### Task 2: User-selected scope grants

**Files:**

- Modify: `src/claims.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Modify: `src/db.ts`
- Test: `test/claims.test.ts`
- Test: `test/oauth.test.ts`
- Test: `test/device.test.ts`

**Interfaces:**

- Produces: `selectGrantedScopes(requested: readonly Scope[], value: string | null): Scope[]`.
- Changes: `approveDeviceGrant(..., scopes: readonly Scope[]): Promise<boolean>` persists selected scopes.

- [ ] **Step 1: Add failing unit and route tests**

```ts
expect(selectGrantedScopes(["openid", "email", "name"], "openid name")).toEqual(["openid", "name"]);
expect(() => selectGrantedScopes(["openid", "email"], "openid avatar")).toThrow();
```

Add authorization-code and device tests that request `openid email name`, approve `openid name`, and assert stored/returned scope is exactly `openid name`.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `pnpm test -- test/claims.test.ts test/oauth.test.ts test/device.test.ts`

Expected: missing helper and routes ignoring submitted scope.

- [ ] **Step 3: Implement strict subset validation**

```ts
export function selectGrantedScopes(requested: readonly Scope[], value: string | null): Scope[] {
  const granted = parseScopes(value ?? "openid");
  if (granted.some((scope) => !requested.includes(scope))) {
    throw new Error("granted scope was not requested");
  }
  return granted;
}
```

- [ ] **Step 4: Apply selected scopes at both approval boundaries**

On browser approval, read `scope`, validate against `row.scopes`, pass selected scopes to `startProvider`, and serialize them into `oauth_transactions`. On device approval, include `scope` in duplicate checks, validate it against the grant, and use it for the provider and transaction.

At device callback, pass transaction scopes into `approveDeviceGrant`; update `device_grants.scopes` in the same approval statement so token exchange returns the selected subset.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- test/claims.test.ts test/oauth.test.ts test/device.test.ts`

Expected: all focused tests pass, including rejected scope escalation.

### Task 3: Consent, device, and demo controls

**Files:**

- Create: `src/scripts/disclosure-controls.ts`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/demo/index.astro`
- Modify: `src/pages/demo/callback.astro`
- Modify: `src/styles/global.css`
- Test: `test/ui.test.ts`

**Interfaces:**

- Produces: `renderDisclosureControls(container, scopes): void` and `selectedDisclosureScope(container): string`.
- Consumes: browser/device approval endpoints accepting a canonical `scope` form field.

- [ ] **Step 1: Replace obsolete static-markup tests with control semantics**

Assert that `openid` is a fixed disclosure, requested profile scopes render checkbox switches, approval bodies contain `scope`, provider configuration uses a `<select>`, successful result headings are not programmatically focused, and profile headings read `SHARED CLAIMS`.

- [ ] **Step 2: Run UI tests and confirm failures**

Run: `pnpm test -- test/ui.test.ts`

Expected: failures against the current static consent list and radio-style provider selector.

- [ ] **Step 3: Add the shared disclosure renderer**

```ts
export function selectedDisclosureScope(container: HTMLElement): string {
  const selected = [
    ...container.querySelectorAll<HTMLInputElement>('input[name="granted-scope"]:checked'),
  ].map((input) => input.value);
  return ["openid", ...selected].join(" ");
}
```

Render the three identity rows without switches and one labeled switch for each requested profile scope, using user-facing descriptions.

- [ ] **Step 4: Wire browser and device approval**

Import the shared renderer from each Astro script. Send `scope: selectedDisclosureScope(disclosures)` in both approval requests. Profile switches default off and are removed whenever an inspected request is reset.

- [ ] **Step 5: Clarify demo controls and successful results**

Replace generated provider radios with one labeled `<select id="demo-provider">`; update capability lookup and locking to use its value. Rename both profile result headings to `SHARED CLAIMS` and remove success-heading `.focus()` calls and `tabindex="-1"`.

- [ ] **Step 6: Style the select and switches responsively**

Use existing rule, surface, signal, focus, and minimum-target tokens. A switch must show both text and shape state; mobile disclosure rows collapse to one column without hiding the control.

- [ ] **Step 7: Run UI and protocol tests**

Run: `pnpm test -- test/ui.test.ts test/demo-protocol.test.ts`

Expected: all tests pass.

### Task 4: Product copy and coral visual pass

**Files:**

- Modify: `src/components/Shell.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/me.astro`
- Modify: `src/styles/global.css`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `README.md`
- Test: `test/ui.test.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Keeps all route URLs unchanged.
- Documents `avatar` request scope mapping to the standard `picture` claim.

- [ ] **Step 1: Update copy expectations**

Require `IDENTITY, THAT WORKS`, `IDENTITY HANDSHAKE`, `CHECK THE CONNECTION`, real footer anchors, no `ME` nav anchor, `pid_` examples, and no `BROKER UPSTREAM`, `NO KEYBOARD`, `VERIFIED OPTIONAL CLAIMS`, or developer-facing email warning.

- [ ] **Step 2: Run copy tests and confirm failures**

Run: `pnpm test -- test/ui.test.ts test/config.test.ts`

Expected: failures naming old copy and color documentation.

- [ ] **Step 3: Rewrite landing and transaction copy**

Use `IDENTITY, / THAT WORKS.` for the hero. Describe choosing a provider, approving a connection, local verification, and authorizing another device. Explain consent as a choice over requested profile claims.

- [ ] **Step 4: Update navigation, footer, and account spacing**

Keep `DEMO`, `DISCOVERY`, and `SOURCE` in the header. Footer anchors are `TRY TRIAD`, `DISCOVERY`, `ACCOUNT`, and `SOURCE`. Add an `account-actions` class with visible margin above sign out.

- [ ] **Step 5: Change signal color and documentation**

Set `--signal: oklch(0.72 0.19 38)` and `--signal-ink: oklch(0.11 0.02 38)`. Update `DESIGN.md` consent behavior and palette, `PRODUCT.md` positioning, and README scope/claim and OIDC `pairwise` explanations.

- [ ] **Step 6: Run copy tests**

Run: `pnpm test -- test/ui.test.ts test/config.test.ts`

Expected: all tests pass.

### Task 5: Repository formatting, verification, and release

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `.prettierignore`
- Modify: all supported project text files through Prettier
- Add: `AGENTS.md`

**Interfaces:**

- Produces: `pnpm format` and `pnpm format:check`.
- Changes: `pnpm check` includes `format:check`.

- [ ] **Step 1: Add formatting dependencies and scripts**

Run: `pnpm add -D prettier prettier-plugin-astro`

Add scripts:

```json
"format": "prettier --write .",
"format:check": "prettier --check .",
"check": "pnpm format:check && pnpm typecheck && pnpm build && pnpm test && pnpm check:deploy"
```

Ignore generated and secret paths: `dist`, `.astro`, `.wrangler`, `node_modules`, `.dev.vars`, and `src/generated`.

- [ ] **Step 2: Format the repository and inspect the diff**

Run: `pnpm format`

Expected: supported files are consistently formatted; secrets and generated output are untouched.

- [ ] **Step 3: Run the complete verification suite**

Run: `pnpm check:config && pnpm check`

Expected: formatting, typecheck, Astro build, all Vitest tests, config validation, and Wrangler dry-run pass.

- [ ] **Step 4: Validate responsive browser surfaces**

Run the local Worker and inspect landing, demo, consent, device verification, callback success, and account at desktop and mobile widths. Confirm no overflow, focus ring on keyboard use, real switches, select semantics, and spacing above sign out.

- [ ] **Step 5: Review, commit, push, and deploy**

Inspect `git status`, `git diff`, and recent commits; commit only intended files using lowercase Conventional Commit subjects. Push `main`, run `pnpm deploy`, and record the Worker version.

- [ ] **Step 6: Smoke-test production**

Verify `/api/providers`, discovery, JWKS, landing, demo, consent redirect, and Google/GitHub upstream redirects. Confirm Twitter remains absent without credentials.
