# Better Auth Authorization Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate Better Auth based Triad authorization server with deterministic triple identity, OAuth/OIDC access and refresh tokens, CIMD, public DCR, MCP resources, and RFC 8628 device authorization without changing or deploying the existing custom broker.

**Architecture:** The `triad-better-auth` branch adds a second Worker entry and an isolated D1 schema. One bootstrap task establishes exact Better Auth dependencies, package patches, test infrastructure, and shared contracts; six non-overlapping workstreams then run in parallel; a final integration task alone assembles the auth factory, generates migrations, creates isolated Cloudflare resources, and deploys the new Worker.

**Tech Stack:** TypeScript 6, Better Auth `1.7.0-rc.1`, `@better-auth/oauth-provider`, `@better-auth/cimd`, Drizzle ORM for D1, Hono, Astro, Cloudflare Workers, Vite+

## Global Constraints

- The integration branch is `triad-better-auth`; `main` remains the existing custom Triad implementation.
- The new Worker and D1 database are both named `triad-better-auth`.
- The new Worker entry is `src/better-auth-worker.ts` and its config is `wrangler.better-auth.toml`.
- New migrations live only in `migrations-better-auth/`.
- Never modify or deploy `wrangler.toml`, `migrations/`, or `src/index.ts` in this plan.
- Never touch `vite.config.ts`.
- Pin every Better Auth package to `1.7.0-rc.1`; do not use version ranges.
- Use TypeScript 6 and the existing Vite+ commands.
- Follow TDD: observe the focused test fail before production changes.
- Run `vp run check` and `vp run build` in every workstream before commit.
- Google, GitHub, and Twitter accounts never link, even when emails match.
- Upstream provider tokens are discarded; only Triad-issued OAuth tokens persist.
- `provider_sub`, `account_sub`, and `pairwise_sub` retain the derivations in the approved design.
- JWT access-token `sub` and introspection `sub` are global `account_sub`; OIDC-facing `sub` is exact-client `pairwise_sub`.
- CIMD is primary; unauthenticated DCR is public-only and never issues a client secret.
- Do not mount Better Auth's stock `deviceAuthorization()` plugin.
- The final deployment must not modify the `triad-auth-broker` Worker or `triad-auth` D1 database.

## Branch And Worktree Graph

```text
main (preserved custom implementation)
  \
   triad-better-auth (integration and merge target)
      |
      +-- Task 1 bootstrap worktree, then merge
      |
      +-- Task 2 identity worktree -----------+
      +-- Task 3 claims worktree -------------+
      +-- Task 4 clients worktree ------------+-- merge into triad-better-auth
      +-- Task 5 MCP resources worktree ------+
      +-- Task 6 device grant worktree -------+
      +-- Task 7 UI worktree -----------------+
      |
      +-- Task 8 serial integration and isolated deployment
```

Each feature worktree branches from the exact `triad-better-auth` commit produced by Task 1. Tasks 2-7 must not edit files owned by another workstream.

---

### Task 1: Better Auth Bootstrap And Patch Contracts

**Execution:** Sequential subagent worktree. Merge this task before creating Tasks 2-7 worktrees.

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `pnpm-workspace.yaml`
- Create: `patches/@better-auth__oauth-provider@1.7.0-rc.1.patch`
- Create: `patches/@better-auth__cimd@1.7.0-rc.1.patch`
- Create: `src/better-auth/env.ts`
- Create: `src/better-auth/constants.ts`
- Create: `src/better-auth/contracts.ts`
- Create: `src/better-auth/db.ts`
- Create: `src/better-auth/schema.ts`
- Create: `test/better-auth/d1.ts`
- Create: `test/better-auth/bootstrap.test.ts`
- Create: `test/better-auth/patches.test.ts`

**Interfaces:**
- Produces `BetterAuthEnv`, `AUTH_BASE_PATH`, `DEVICE_GRANT_TYPE`, `createDatabase()`, patched subject-resolution types, patched CIMD fetch/metadata hooks, and the installed package baseline consumed by every parallel task.

- [ ] **Step 1: Add failing bootstrap contract tests**

Create `test/better-auth/bootstrap.test.ts` asserting exact dependency versions, the isolated names, and shared constants:

```ts
expect(packageJson.dependencies).toMatchObject({
  "@better-auth/cimd": "1.7.0-rc.1",
  "@better-auth/oauth-provider": "1.7.0-rc.1",
  "better-auth": "1.7.0-rc.1",
});
expect(AUTH_BASE_PATH).toBe("/api/auth");
expect(DEVICE_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:device_code");
```

Run: `vp test test/better-auth/bootstrap.test.ts`

Expected: FAIL because packages and modules do not exist.

- [ ] **Step 2: Install exact dependencies and define shared runtime contracts**

Install exact versions:

```sh
vp add --save-exact better-auth@1.7.0-rc.1 @better-auth/oauth-provider@1.7.0-rc.1 @better-auth/cimd@1.7.0-rc.1 drizzle-orm@0.45.2
vp add --save-dev --save-exact auth@1.7.0-rc.1 drizzle-kit@0.31.10 miniflare@4.20260708.1
```

Define `src/better-auth/env.ts`:

```ts
export interface BetterAuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  IDENTIFIER_SECRET: string;
  OAUTH_RESOURCES_JSON?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TWITTER_CLIENT_ID?: string;
  TWITTER_CLIENT_SECRET?: string;
}
```

Define `src/better-auth/constants.ts`:

```ts
export const AUTH_BASE_PATH = "/api/auth";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const BETTER_AUTH_WORKER_NAME = "triad-better-auth";
export const BETTER_AUTH_DATABASE_NAME = "triad-better-auth";
```

Define `src/better-auth/contracts.ts`:

```ts
import type { BetterAuthPlugin } from "better-auth";
import type { BetterAuthEnv } from "./env";

export interface BetterAuthModule {
  readonly id: string;
  plugins(env: BetterAuthEnv): readonly BetterAuthPlugin[];
}

export interface TriadUser {
  id: string;
  provider: "google" | "github" | "twitter";
  providerSub: string;
}
```

Create `src/better-auth/db.ts` using the official Worker pattern:

```ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDatabase(binding: D1Database) {
  return drizzle(binding, { schema });
}
```

Use a temporary empty `src/better-auth/schema.ts` export until Task 8 generates the complete schema.

```ts
export {};
```

- [ ] **Step 3: Add failing package-patch tests**

Create `test/better-auth/patches.test.ts` proving these public options compile and affect runtime behavior:

```ts
oauthProvider({
  resolveSubjectIdentifier: ({ subject, clientId, use }) =>
    use === "introspection" ? subject : `${clientId}:${subject}`,
  allowUnauthenticatedConfidentialClientRegistration: false,
});

cimd({
  fetch: async (request) => fetch(request, { redirect: "manual" }),
  resolveMetadata: ({ metadata }) => metadata,
});
```

The runtime tests must show that ID token/UserInfo/logout use the resolver, JWT access-token and introspection `sub` remain global, open DCR rejects secret-bearing clients, and CIMD invokes both injected hooks.

Run: `vp test test/better-auth/patches.test.ts`

Expected: FAIL because RC.1 lacks these options.

- [ ] **Step 4: Create minimal upstream-shaped pnpm patches**

Patch `@better-auth/oauth-provider` to add:

```ts
type SubjectIdentifierUse = "id_token" | "userinfo" | "logout_token" | "introspection";

resolveSubjectIdentifier?: (input: {
  subject: string;
  clientId: string;
  subjectType: "public" | "pairwise" | undefined;
  use: SubjectIdentifierUse;
  defaultSubject: string;
}) => Promise<string> | string;

allowUnauthenticatedConfidentialClientRegistration?: boolean;
```

The resolver applies to OIDC-facing subjects. For `use === "introspection"`, Triad can return the raw global subject. The DCR guard rejects anonymous methods other than `none` and grants other than `authorization_code` plus optional `refresh_token`.

Patch `@better-auth/cimd` to add injectable `fetch` and `resolveMetadata` hooks. Keep built-in validation before the resolver and repeat validation after it.

Register both patches under `patchedDependencies` in `pnpm-workspace.yaml`.

- [ ] **Step 5: Add real D1 test infrastructure**

Create `test/better-auth/d1.ts` using Miniflare with one D1 binding and helpers:

```ts
export async function createBetterAuthD1(): Promise<{
  db: D1Database;
  dispose(): Promise<void>;
}>;

export async function applySql(db: D1Database, sql: string): Promise<void>;
```

Do not change `vite.config.ts`. Keep Miniflare lifecycle inside each test file.

- [ ] **Step 6: Verify and commit bootstrap**

Run:

```sh
vp test test/better-auth/bootstrap.test.ts test/better-auth/patches.test.ts
vp run check
vp run build
```

Expected: all bootstrap tests pass and existing application tests still compile.

Commit: `feat: bootstrap better auth authorization server`

---

### Task 2: Deterministic Identity And Upstream Providers

**Execution:** Parallel worktree `triad-ba-identity` from the Task 1 merge commit.

**Files:**
- Create: `src/better-auth/identity/subjects.ts`
- Create: `src/better-auth/identity/providers.ts`
- Create: `src/better-auth/identity/options.ts`
- Create: `test/better-auth/identity-subjects.test.ts`
- Create: `test/better-auth/identity-providers.test.ts`

**Interfaces:**
- Produces `deriveIdentity()`, `pairwiseSubject()`, and `createIdentityOptions(env)` for Task 8.

- [ ] **Step 1: Write failing deterministic identity tests**

Test exact formats and behavior:

```ts
const identity = await deriveIdentity(secret, { provider: "google", upstreamId: "42" });
expect(identity.providerSub).toMatch(/^pid_google_[0-9a-f]{64}$/);
expect(identity.accountSub).toMatch(/^acc_[0-9a-f]{64}$/);
expect(identity.syntheticEmail).toBe(`${identity.accountSub}@identity.invalid`);
expect(await pairwiseSubject(secret, identity.accountSub, "https://client.example/meta.json"))
  .toMatch(/^pws_[0-9a-f]{64}$/);
```

Also prove provider separation, exact-client separation, and deterministic recreation.

Run: `vp test test/better-auth/identity-subjects.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement subject derivation and provider mapping**

Export:

```ts
export type ProviderName = "google" | "github" | "twitter";

export function deriveIdentity(
  secret: string,
  input: { provider: ProviderName; upstreamId: string },
): Promise<{
  provider: ProviderName;
  providerSub: string;
  accountSub: string;
  syntheticEmail: string;
}>;

export function pairwiseSubject(
  secret: string,
  accountSub: string,
  clientId: string,
): Promise<string>;
```

Use the approved domain-separated HMAC inputs and reject secrets shorter than 32 characters.

Provider profile mapping must replace the upstream profile ID with `providerSub`, return the synthetic email, and set `provider` and `providerSub` additional fields. Google requests only `openid`; GitHub reads only `/user`; Twitter requests only `tweet.read users.read`. Real upstream email never becomes Better Auth's identity email.

- [ ] **Step 3: Write failing policy-hook tests**

Test that `createIdentityOptions(env)`:

- Disables email/password and all account linking.
- Uses deterministic `accountSub` as `user.id` on creation.
- Makes `provider` and `providerSub` immutable.
- Clears upstream access, refresh, and ID tokens, expiry fields, and scope on account create/update.
- Rejects half-configured provider credential pairs and requires at least one complete pair.

Run: `vp test test/better-auth/identity-providers.test.ts`

Expected: FAIL before policy options exist.

- [ ] **Step 4: Implement Better Auth identity options**

Export:

```ts
export function createIdentityOptions(env: BetterAuthEnv): Pick<
  BetterAuthOptions,
  "account" | "databaseHooks" | "emailAndPassword" | "socialProviders" | "user"
>;
```

Set `accountLinking.enabled=false`, `disableImplicitLinking=true`, `trustedProviders=[]`, `storeAccountCookie=false`, and `updateAccountOnSignIn=false`. Set token fields to `null`, not `undefined`, in hooks.

- [ ] **Step 5: Verify and commit identity module**

Run:

```sh
vp test test/better-auth/identity-subjects.test.ts test/better-auth/identity-providers.test.ts
vp run check
vp run build
```

Commit: `feat: add deterministic better auth identities`

---

### Task 3: Triple Claims And Exact-Client OIDC Subjects

**Execution:** Parallel worktree `triad-ba-claims` from the Task 1 merge commit.

**Files:**
- Create: `src/better-auth/oauth/claims.ts`
- Create: `test/better-auth/oauth-claims.test.ts`

**Interfaces:**
- Produces `createTriadSubjectResolver()` and `createTriadClaimsExtension()` for Task 8.

- [ ] **Step 1: Write failing claim-contract tests**

Assert:

```text
ID token sub               pairwise_sub
UserInfo sub               pairwise_sub
JWT access-token sub       account_sub
JWT introspection sub      account_sub
account_sub custom claim   user.id
provider_sub custom claim  user.providerSub
pairwise_sub custom claim  exact-client HMAC
```

Prove two client IDs on one hostname receive different pairwise subjects and refresh issuance preserves all claims.

Run: `vp test test/better-auth/oauth-claims.test.ts`

Expected: FAIL before claims module exists.

- [ ] **Step 2: Implement resolver and extension**

Export:

```ts
export function createTriadSubjectResolver(
  identifierSecret: string,
): NonNullable<OAuthOptions["resolveSubjectIdentifier"]>;

export function createTriadClaimsExtension(
  identifierSecret: string,
): OAuthProviderExtension;
```

The resolver returns raw `subject` only for introspection and exact-client `pairwiseSubject()` for OIDC uses. The extension contributes `account_sub`, `provider_sub`, and `pairwise_sub` to ID token, UserInfo, and user access-token claims. Client-credentials issuance contributes no user claims.

- [ ] **Step 3: Verify and commit claims module**

Run:

```sh
vp test test/better-auth/oauth-claims.test.ts
vp run check
vp run build
```

Commit: `feat: add triple oauth identity claims`

---

### Task 4: CIMD And Public DCR Client Admission

**Execution:** Parallel worktree `triad-ba-clients` from the Task 1 merge commit.

**Files:**
- Create: `src/better-auth/clients/public-fetch.ts`
- Create: `src/better-auth/clients/cimd.ts`
- Create: `src/better-auth/clients/dcr.ts`
- Create: `test/better-auth/public-fetch.test.ts`
- Create: `test/better-auth/cimd.test.ts`
- Create: `test/better-auth/dcr.test.ts`

**Interfaces:**
- Produces `createTriadCimd(env)` and `createPublicDcrHook()` for Task 8.

- [ ] **Step 1: Write failing public-fetch and CIMD tests**

Cover HTTPS metadata URLs, exact client ID, mandatory `client_name`, 5 KiB body limit, five-second timeout, manual redirect rejection, private/special-use addresses, public DNS answers, same-origin `jwks_uri`, `none`, and `private_key_jwt`.

Run: `vp test test/better-auth/public-fetch.test.ts test/better-auth/cimd.test.ts`

Expected: FAIL before modules exist.

- [ ] **Step 2: Implement Worker-safe CIMD policy**

Export:

```ts
export function createPublicDocumentFetch(options: {
  fetcher?: typeof fetch;
  resolveDns(hostname: string): Promise<string[]>;
}): (request: Request) => Promise<Response>;

export function createTriadCimd(env: BetterAuthEnv): BetterAuthPlugin;
```

Use `redirect:"manual"` because Workers rejects `redirect:"error"`. Reject every redirect response. Require `client_name` between 1 and 80 Unicode code points, force pairwise client behavior, reject symmetric secrets, and materialize same-origin public JWKS before persistence.

- [ ] **Step 3: Write failing public-DCR tests**

Assert valid open registration requires explicit `token_endpoint_auth_method=none`, authorization code, optional refresh token, exact redirect URIs, and S256. Assert no response/database secret and no dependence on the HTTP `Origin` header. Reject every confidential method and unrelated grant.

Run: `vp test test/better-auth/dcr.test.ts`

Expected: FAIL before DCR policy exists.

- [ ] **Step 4: Implement DCR normalization and route hook**

Export:

```ts
export function normalizePublicDcrMetadata(input: unknown): {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: ("authorization_code" | "refresh_token")[];
  response_types: ["code"];
  subject_type: "pairwise";
};

export function createPublicDcrHook(): BetterAuthPlugin;
```

The hook runs before Better Auth registration handling and rejects protected/admin metadata on the unauthenticated route.

- [ ] **Step 5: Verify and commit client admission**

Run:

```sh
vp test test/better-auth/public-fetch.test.ts test/better-auth/cimd.test.ts test/better-auth/dcr.test.ts
vp run check
vp run build
```

Commit: `feat: add automatic oauth client admission`

---

### Task 5: MCP Resource And Refresh Policy

**Execution:** Parallel worktree `triad-ba-mcp` from the Task 1 merge commit.

**Files:**
- Create: `src/better-auth/mcp/resources.ts`
- Create: `src/better-auth/mcp/resource-server.ts`
- Create: `test/better-auth/resources.test.ts`
- Create: `test/better-auth/resource-server.test.ts`

**Interfaces:**
- Produces parsed OAuth resource options and RFC 9728/resource-token helpers for Task 8.

- [ ] **Step 1: Write failing resource policy tests**

Test absolute fragment-free unique resources, exact scope allowlists, five-minute JWT access tokens, 30-day rotating refresh tokens, unknown-resource rejection, and no production resource when configuration is absent.

Run: `vp test test/better-auth/resources.test.ts`

Expected: FAIL before resource parser exists.

- [ ] **Step 2: Implement resource configuration**

Export:

```ts
export interface TriadResourceConfig {
  identifier: string;
  name: string;
  allowedScopes: string[];
}

export function parseResources(value?: string): TriadResourceConfig[];

export function createResourceOptions(resources: TriadResourceConfig[]): Pick<
  OAuthOptions,
  "accessTokenExpiresIn" | "enforcePerClientResources" | "idTokenExpiresIn" |
  "refreshTokenExpiresIn" | "refreshTokenReuseInterval" | "resources"
>;
```

Set `enforcePerClientResources=false` so every automatically admitted client may request a recognized resource. Unknown resources remain `invalid_target`.

- [ ] **Step 3: Write failing MCP resource-server tests**

Test RFC 9728 metadata, `WWW-Authenticate` challenges, JWT signature/issuer/audience/expiry/scope validation, `401` invalid-token behavior, and `403 insufficient_scope` behavior.

Run: `vp test test/better-auth/resource-server.test.ts`

Expected: FAIL before resource helper exists.

- [ ] **Step 4: Implement MCP resource helper and verify**

Export:

```ts
export function createMcpResourceServer(options: {
  issuer: string;
  resource: string;
  scopes: string[];
}): {
  metadata(): Response;
  verify(request: Request): Promise<Record<string, unknown>>;
  challenge(scopes?: string[]): Response;
};
```

Use Better Auth's OAuth Provider resource-client verifier rather than implementing JWT verification independently.

Run:

```sh
vp test test/better-auth/resources.test.ts test/better-auth/resource-server.test.ts
vp run check
vp run build
```

Commit: `feat: add mcp resource authorization`

---

### Task 6: RFC 8628 OAuth Device Grant Companion

**Execution:** Parallel worktree `triad-ba-device` from the Task 1 merge commit.

**Files:**
- Create: `src/better-auth/device/codes.ts`
- Create: `src/better-auth/device/schema.ts`
- Create: `src/better-auth/device/plugin.ts`
- Create: `test/better-auth/device-codes.test.ts`
- Create: `test/better-auth/device-grant.test.ts`

**Interfaces:**
- Produces `oauthDeviceGrant(options)` Better Auth plugin for Task 8; its schema is included by final Better Auth schema generation.

- [ ] **Step 1: Write failing code and schema tests**

Assert 32-byte random device codes, hashed persistence, normalized unambiguous user codes, ten-minute expiry, five-second polling, uniqueness, and no plaintext device code in rows.

Run: `vp test test/better-auth/device-codes.test.ts`

Expected: FAIL before the module exists.

- [ ] **Step 2: Implement self-contained plugin contract**

Export:

```ts
export interface OAuthDeviceGrantOptions {
  verificationUri: string;
  expiresInSeconds?: number;
  pollingIntervalSeconds?: number;
}

export function oauthDeviceGrant(options: OAuthDeviceGrantOptions): BetterAuthPlugin;
```

The plugin contributes its `oauthDeviceGrant` schema, `POST /oauth2/device_authorization`, authenticated verification/approve/deny endpoints, authorization-server metadata, and an OAuth Provider extension grant registered under `DEVICE_GRANT_TYPE`.

- [ ] **Step 3: Write failing end-to-end grant tests**

Test public and `private_key_jwt` clients, exact scopes/resources, consent, pending, slow-down with interval increase, denial, expiry, wrong client, one-winner redemption, refresh/ID token issuance, and absence of Better Auth session-token issuance.

Run: `vp test test/better-auth/device-grant.test.ts`

Expected: FAIL until extension grant integration exists.

- [ ] **Step 4: Implement token issuance through OAuth Provider API**

Use `getOAuthProviderApi()` and `extendOAuthProvider()`. Authenticate the polling client, atomically consume approved state, load user/session/authentication time, and call `provider.issueTokens()` with stored client, scopes, resources, and confirmation. Do not require PKCE for the RFC 8628 grant.

- [ ] **Step 5: Verify and commit device grant**

Run:

```sh
vp test test/better-auth/device-codes.test.ts test/better-auth/device-grant.test.ts
vp run check
vp run build
```

Commit: `feat: add oauth provider device grant`

---

### Task 7: Better Auth Product And Consent Surfaces

**Execution:** Parallel worktree `triad-ba-ui` from the Task 1 merge commit.

**Files:**
- Modify: `src/pages/index.astro`
- Create: `src/pages/sign-in.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/me.astro`
- Modify: `src/pages/device/verify.astro`
- Create: `src/scripts/better-auth-client.ts`
- Create: `test/better-auth/ui.test.ts`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes endpoint contracts fixed in this plan; produces prerendered product pages for Task 8's Worker asset fallback.

- [ ] **Step 1: Write failing UI contract tests**

Require sign-in provider actions, separate client/resource consent ledgers, account display of three IDs, consent revocation, account deletion, device code approval/denial, exact async states, accessible focus/live regions, and narrow-screen wrapping.

Run: `vp test test/better-auth/ui.test.ts`

Expected: FAIL because Better Auth pages and client code do not exist.

- [ ] **Step 2: Implement Better Auth browser client and pages**

Export from `src/scripts/better-auth-client.ts`:

```ts
export type ProviderName = "google" | "github" | "twitter";

export function oauthQueryFromLocation(): string | null;

export function beginSocialSignIn(
  provider: ProviderName,
  oauthQuery?: string,
  returnTo?: string,
): Promise<void>;

export function responseError(response: Response, fallback: string): Promise<Error>;
```

Use Better Auth's client plugin for session and OAuth consent operations. Do not implement signing, PKCE, token parsing, or authorization-query validation in the browser.

- [ ] **Step 3: Preserve Triad's visual and accessibility system**

Keep the near-black field, warm text, coral signal color, square ledgers, display/mono hierarchy, explicit loading/error/retry states, keyboard focus, minimum touch targets, reduced motion, and responsive identifier wrapping. Display mandatory scopes as factual rows, not checkboxes.

- [ ] **Step 4: Verify and commit UI**

Run:

```sh
vp run build
vp test test/better-auth/ui.test.ts test/ui.test.ts
vp run check
vp run build
```

Commit: `feat: add better auth product flows`

---

### Task 8: Serial Composition, Fresh Schema, And Isolated Deployment

**Execution:** Only after Tasks 2-7 have passed independent review and merged into `triad-better-auth`. No parallel worktree.

**Files:**
- Create: `src/better-auth/auth.ts`
- Create: `src/better-auth/schema-config.ts`
- Create: `src/better-auth/schema.ts`
- Create: `src/better-auth-worker.ts`
- Create: `wrangler.better-auth.toml`
- Create: `drizzle.better-auth.config.ts`
- Create: `migrations-better-auth/**`
- Create: `test/better-auth/integration.test.ts`
- Create: `test/better-auth/deployment.test.ts`
- Modify: `.dev.vars.example`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes every module exported by Tasks 2-7; produces the only complete auth factory, Worker entry, generated schema, deployment config, and production rollout.

- [ ] **Step 1: Write failing integration tests**

Cover deterministic provider creation, no token persistence, disabled linking, exact-client OIDC subject, global access-token/introspection subject, all triple claims, CIMD public/private clients, public DCR, resource JWT/refresh behavior, device flow, account deletion/recreation, discovery, and JWKS.

Run: `vp test test/better-auth/integration.test.ts`

Expected: FAIL because no complete auth factory exists.

- [ ] **Step 2: Assemble the sole auth factory**

Implement:

```ts
export function createTriadAuth(env: BetterAuthEnv) {
  const resources = parseResources(env.OAUTH_RESOURCES_JSON);

  return betterAuth({
    baseURL: env.AUTH_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createDatabase(env.DB), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    ...createIdentityOptions(env),
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "ES256" } } }),
      oauthProvider({
        loginPage: "/sign-in/",
        consentPage: "/consent/",
        pairwiseSecret: env.IDENTIFIER_SECRET,
        resolveSubjectIdentifier: createTriadSubjectResolver(env.IDENTIFIER_SECRET),
        extensions: [createTriadClaimsExtension(env.IDENTIFIER_SECRET)],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        allowUnauthenticatedConfidentialClientRegistration: false,
        clientRegistrationRequirePKCE: true,
        ...createResourceOptions(resources),
      }),
      createTriadCimd(env),
      createPublicDcrHook(),
      oauthDeviceGrant({ verificationUri: "/device/verify/" }),
    ],
  });
}
```

- [ ] **Step 3: Generate and verify a fresh Better Auth schema**

Generate schema and migrations only after the complete plugin list exists:

```sh
vp exec auth generate --config ./src/better-auth/schema-config.ts --output ./src/better-auth/schema.ts --yes
vp exec drizzle-kit generate --config ./drizzle.better-auth.config.ts --name better_auth_initial
vp exec drizzle-kit check --config ./drizzle.better-auth.config.ts
```

The generated migration must include core user/session/account tables, rate limit, JWKS, OAuth client/resource/token/consent/assertion tables, user provider fields, and the custom OAuth device-grant table.

- [ ] **Step 4: Implement an isolated Worker entry**

`src/better-auth-worker.ts` creates auth per request environment, routes `/api/auth/*` and required well-known aliases to `auth.handler`, serves Astro assets, applies existing security headers, and adds no-store protocol headers. It never imports `src/index.ts`.

Create `wrangler.better-auth.toml` with:

```toml
name = "triad-better-auth"
main = "src/better-auth-worker.ts"
compatibility_date = "2026-07-09"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = true

[vars]
AUTH_ORIGIN = "https://triad-better-auth.equator-owl-studio.workers.dev"

[assets]
directory = "./dist"
binding = "ASSETS"
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"
run_worker_first = true
```

Do not add a D1 UUID manually. Create the isolated database and let Wrangler update only this config:

```sh
vp exec wrangler d1 create triad-better-auth --binding DB --update-config --config wrangler.better-auth.toml
```

Confirm the command changed only `wrangler.better-auth.toml` and references `migrations-better-auth`.

- [ ] **Step 5: Add isolated scripts and deployment tests**

Add:

```json
{
  "check:better-auth:deploy": "wrangler deploy --dry-run --config wrangler.better-auth.toml",
  "db:better-auth:local": "wrangler d1 migrations apply triad-better-auth --local --config wrangler.better-auth.toml",
  "db:better-auth:remote": "wrangler d1 migrations apply triad-better-auth --remote --config wrangler.better-auth.toml",
  "deploy:better-auth": "vp run build && vp run check && vp exec wrangler deploy --config wrangler.better-auth.toml"
}
```

`test/better-auth/deployment.test.ts` must prove the old and new Worker names, D1 names, entries, migration directories, and deploy commands cannot cross.

- [ ] **Step 6: Run complete local verification and commit**

Run:

```sh
vp run db:better-auth:local
vp test
vp run check
vp run build
vp run check:better-auth:deploy
vp exec drizzle-kit check --config ./drizzle.better-auth.config.ts
git diff --check
```

Commit: `feat: assemble better auth authorization server`

- [ ] **Step 7: Configure and deploy only the new production resources**

Upload secrets using `--config wrangler.better-auth.toml`: `BETTER_AUTH_SECRET`, `IDENTIFIER_SECRET`, and enabled provider credential pairs. Set `OAUTH_RESOURCES_JSON` as a non-secret production variable only when a real resource is ready; do not seed example resources.

Apply and deploy:

```sh
vp run db:better-auth:remote
vp run deploy:better-auth
```

Verify the workers.dev issuer, authorization metadata, OIDC discovery, JWKS, CIMD capability, DCR endpoint, device endpoint/grant advertisement, public assets, and one complete test-resource flow. Never invoke `vp run db:remote` or `vp run deploy` during this rollout because those target the existing broker.
