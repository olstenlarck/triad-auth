# Architecture

Triad remains an identity broker with its own public identity namespace. Better Auth supplies sessions, upstream OAuth, OAuth/OIDC authorization-server behavior, device authorization, DCR, CIMD discovery, token issuance, and Cloudflare D1 persistence.

## Public identifiers

All identifiers are keyed HMAC-SHA-256 derivations under `TRIAD_ROOT_SECRET`:

- `account_sub = HMAC("account-sub\0" + provider + ":" + upstream_subject)`
- `provider_sub = HMAC("provider-sub\0" + provider + ":" + upstream_subject)`
- `pairwise_sub = HMAC("pairwise-sub\0" + account_sub + "\0" + client_id)`

Raw upstream provider IDs are consumed only while mapping the provider response. The account database hook replaces Better Auth's upstream `accountId` with `provider_sub` and discards upstream provider tokens.

Triad deliberately does not link identities across providers. A Google identity and a GitHub identity are separate Triad accounts.

## OAuth clients

Two client onboarding mechanisms coexist:

- DCR creates a normal registered client and therefore has full per-client semantics.
- CIMD uses the official `@better-auth/cimd` discovery plugin. The full HTTPS document URL is the protocol `client_id`; application policy may separately canonicalize it.

The Better Auth OAuth Provider verifies `private_key_jwt` natively. CIMD clients may publish inline `jwks` or a same-origin `jwks_uri`. Public clients can use `none` with PKCE.

## Claims

`openid` returns Triad's three opaque identifiers. Standard profile/email claims are available only when those scopes are requested. No upstream subject is emitted.

## Runtime

The service is a Hono Cloudflare Worker. Better Auth talks directly to the D1 binding. Secrets are Worker secrets; only the public base URL is committed in Wrangler configuration.
