# Architecture

Triad remains an identity broker with its own public identity namespace. Better Auth supplies sessions, upstream OAuth, OAuth/OIDC authorization-server behavior, device authorization, DCR, CIMD discovery, token issuance, and Cloudflare D1 persistence.

## Identity mapping

The three identities have different jobs:

| Better Auth / OIDC field | Triad value    |
| ------------------------ | -------------- |
| `user.id`                | `account_sub`  |
| `account.userId`         | `account_sub`  |
| `account.accountId`      | `provider_sub` |
| OIDC `sub`               | `pairwise_sub` |

All identifiers are keyed HMAC-SHA-256 derivations under `TRIAD_ROOT_SECRET`:

- `account_sub = HMAC("account-sub\0" + provider + ":" + upstream_subject)`
- `provider_sub = HMAC("provider-sub\0" + provider + ":" + upstream_subject)`
- `pairwise_sub = HMAC("pairwise-sub\0" + account_sub + "\0" + client_id)`

The provider mapper replaces the raw upstream ID with `provider_sub` before Better Auth performs account lookup. It carries `account_sub` into the user-create hook, which forces the database primary key to that value. OAuth Provider subject resolution then derives `pairwise_sub` from the stored `user.id` and the requesting client ID.

Raw upstream provider IDs are never persisted or emitted. Provider tokens are discarded by the account creation hook.

Triad deliberately does not link identities across providers. It uses a deterministic non-routable internal email based on `account_sub`, preventing Better Auth's email fallback lookup from collapsing equal upstream emails into one user.

## Exact subject override

Better Auth 1.7 RC does not expose a custom subject resolver. The repository contains a narrow Bun dependency patch that adds `resolveSubjectIdentifier({ userId, clientId })` to `@better-auth/oauth-provider`. It runs before the built-in public/pairwise strategies and therefore covers ID tokens, UserInfo, introspection, logout tokens, refreshes, authorization-code flows, and device flows through the provider's central resolver.

The patch can be removed when Better Auth exposes an equivalent hook upstream.

## OAuth clients

Two client onboarding mechanisms coexist:

- DCR creates a normal registered client and therefore has full per-client semantics.
- CIMD uses the official `@better-auth/cimd` discovery plugin. The full HTTPS document URL is the protocol `client_id`; application policy may separately canonicalize it.

The Better Auth OAuth Provider verifies `private_key_jwt` natively. CIMD clients may publish inline `jwks` or a same-origin `jwks_uri`. Public clients can use `none` with PKCE.

## Claims

The supported scope is currently `openid`. OIDC `sub` is `pairwise_sub`; Triad additionally emits `account_sub` and `provider_sub`. UserInfo also emits `pairwise_sub` as an explicit alias of `sub`.

## Runtime

The service is a Hono Cloudflare Worker. Better Auth talks directly to the D1 binding. Secrets are Worker secrets; only the public base URL is committed in Wrangler configuration.
