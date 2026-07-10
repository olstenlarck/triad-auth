# Triad Auth Broker

A small OAuth/OIDC broker for Google, GitHub, and X, designed around three explicit identifiers and a standards-shaped device flow.

- `sub` and `provider_sub`: the upstream global identity, namespaced as `google:<sub>`, `github:<id>`, or `x:<id>`.
- `account_sub`: the broker account. It becomes cross-provider only after an explicit identity-link operation.
- `pairwise_sub`: an HMAC-derived ID unique to the broker account and downstream `client_id`.

PII is deliberately not implemented in this first slice. Add `email` and `profile` only behind broker-owned consent records and scopes; never use email as an identity key. The included Astro UI provides the landing, consent, device verification, and `/me` account surfaces.

## Why registered clients are mandatory

Publishing `provider_sub` lets sites correlate a user. Unlike a pairwise-only broker, this service must not auto-register arbitrary origins. Every downstream client has an exact redirect URI allowlist and an allowed-provider list.

## Supported flows

- Authorization Code + mandatory PKCE (`S256`)
- OAuth Device Authorization Grant-style flow
- OIDC discovery and ES256 JWKS

Device flow:

1. Device calls `POST /device/code` with `client_id`.
2. User opens `verification_uri`, enters the code, and signs in with a provider.
3. Device polls `POST /token` with grant type `urn:ietf:params:oauth:grant-type:device_code`.
4. The code is atomically consumed and an ID token is returned.

## Run locally

```sh
pnpm install
pnpm keygen
```

Put the generated JSON into the `SIGNING_PRIVATE_JWK` Wrangler secret. Also set a high-entropy `PAIRWISE_SECRET` and the three provider client credential pairs. Each provider callback is:

```text
http://localhost:8787/callback/{google|github|x}
```

Then:

```sh
pnpm db:local
pnpm dev
```

Example authorization request:

```text
/authorize?client_id=local-dev&redirect_uri=http://localhost:3000/callback&provider=google&response_type=code&state=...&code_challenge=...&code_challenge_method=S256
```

## Before production

- Add CSRF protection and a confirmation screen to device approval; do not approve solely from a GET.
- Add explicit, reauthenticated identity linking and unlinking. Never infer links from email.
- Implement PII consent, revocation, audit logs, account deletion, key rotation, rate limits, abuse controls, and provider token disposal.
- Use D1 or Durable Objects for one-time grants. Do not move authorization codes/device grants to eventually consistent KV.
- Normalize issuer URLs, enforce HTTPS outside local development, set security headers, and add structured security telemetry.
- Commission a protocol/security review before accepting real users.

## Stack

- Cloudflare Worker + D1 + static assets
- Astro 7
- pnpm 11
- TypeScript 7
- Hono, JOSE, Vitest

`pnpm typecheck`, `pnpm test`, `pnpm build`, and a Wrangler dry-run are the expected pre-push checks. Astro's standalone language-server checker does not yet support TypeScript 7, so the project uses the TypeScript compiler plus a real Astro production build.

## Data retention

The broker stores provider IDs and its own account mappings. It intentionally discards provider access tokens after resolving identity. PII should remain absent unless a downstream client requests a consented scope.
