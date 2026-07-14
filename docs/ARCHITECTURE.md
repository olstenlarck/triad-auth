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

Raw upstream provider IDs are never persisted or emitted. Better Auth handles upstream account credentials normally; those credentials are distinct from the access, refresh, and ID tokens that Triad issues as an authorization server.

Triad deliberately does not link identities across providers. It uses a deterministic non-routable internal email based on `account_sub`, preventing Better Auth's email fallback lookup from collapsing equal upstream emails into one user. The actual provider email and its provider-reported verification status live in hidden `providerEmail` and `providerEmailVerified` fields.

## Exact subject override

Better Auth 1.7 RC does not expose a custom subject resolver. Its built-in pairwise formula uses the redirect-URI sector and only applies when a client declares `subject_type=pairwise`, while Triad's existing identity contract derives the subject from `account_sub` and `client_id` for every client.

The repository therefore contains a general Bun dependency patch that adds `resolveSubjectIdentifier({ userId, clientId })` and exposes the resolved subject and client ID to the existing custom-claim callbacks. The patch contains no Triad claim names or account lookup behavior. Triad itself emits `account_sub`, `provider_sub`, and the explicit `pairwise_sub` alias through those callbacks.

The patch can be removed when Better Auth exposes an equivalent hook upstream.

## OAuth clients

Two client onboarding mechanisms coexist:

- DCR creates a normal registered client and therefore has full per-client semantics.
- CIMD uses the official `@better-auth/cimd` discovery plugin. The full HTTPS document URL is the protocol `client_id`; application policy may separately canonicalize it.

The Better Auth OAuth Provider verifies `private_key_jwt` natively. CIMD clients may publish inline `jwks` or a same-origin `jwks_uri`. Public clients can use `none` with PKCE.

## Claims

The supported scopes preserve Triad's existing contract: `openid`, `email`, `handle`, `name`, and `avatar`. They release `email`/`email_verified`, `preferred_username`, `name`, and `picture` respectively. The consent screen shows every requested scope and permits partial approval.

OIDC ID-token and UserInfo `sub` is Triad's `pairwise_sub`; Triad also emits that exact value as the explicit `pairwise_sub` claim alongside `account_sub` and `provider_sub`. Access tokens retain Better Auth's internal subject behavior but carry the explicit Triad identity claims. Profile values come only from the hidden provider fields and are omitted unless their scope was granted.

## Runtime

The service is a Hono Cloudflare Worker. Better Auth talks directly to the D1 binding. Secrets are Worker secrets; only the public base URL is committed in Wrangler configuration.
