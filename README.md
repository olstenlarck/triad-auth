# Triad Auth Broker

Triad is a small, inspectable OAuth/OIDC broker for Google, GitHub, and Twitter authentication. It runs as one Cloudflare Worker with D1 and static Astro assets, and includes authorization-code PKCE and device-flow demos.

This repository is an MVP, not a general-purpose identity platform. It makes downstream identity semantics explicit and collects only the optional profile values that a client requests for a one-time authorization transaction.

## Identity claims

Every ID token uses the app-scoped identity as both `sub` and `pairwise_sub`.

- `pairwise_sub`: an HMAC-derived identifier unique to the broker account and downstream `client_id`.
- `account_sub`: a random broker account identifier, stable across receiving Triad clients.
- `provider_sub`: an opaque provider-global identifier that can correlate one upstream identity across receiving Triad clients without exposing the raw upstream ID.

Identity-only authentication is the default. Clients may request the optional scopes `email`, `handle`, `name`, and `avatar`; every requested scope is mandatory for that transaction and is shown before approval. Their standard ID-token claims are `email` plus `email_verified`, `preferred_username`, `name`, and `picture` respectively. These values are mutable profile data, not identity keys.

Consent records retain approved scope names, not profile values. Requested profile values are encrypted until the one-time exchange or expiry, then removed. Upstream access tokens are discarded after the provider response is mapped.

## Supported flows

- Authorization Code with mandatory S256 PKCE
- OAuth Device Authorization Grant-style flow
- OIDC discovery at `/.well-known/openid-configuration`
- ES256 public keys at `/.well-known/jwks.json`

Downstream clients are registered in D1 with exact redirect URI and provider allowlists. There is no dynamic client registration.

## Requirements

- Node.js 22.12 or newer
- pnpm 11
- A GitHub account for creating an OAuth App
- A Cloudflare account for D1 and deployment

Install dependencies:

```sh
pnpm install
```

## GitHub OAuth App

For local development, create a GitHub OAuth App with these values:

- Homepage URL: `http://localhost:8787`
- Authorization callback URL: `http://localhost:8787/callback/github`

GitHub provides the client ID and lets you generate a client secret. Keep both out of Git and terminal command arguments. For production, Task 10 changes the app callback to `<ISSUER>/callback/github`, where `<ISSUER>` is the final stable HTTPS Worker origin with no trailing slash.

## Local configuration

Create the ignored local configuration file:

```sh
cp .dev.vars.example .dev.vars
pnpm keygen
openssl rand -base64 32
```

Fill all four empty assignments in `.dev.vars`:

- `GITHUB_CLIENT_ID`: the GitHub OAuth App client ID.
- `GITHUB_CLIENT_SECRET`: the GitHub OAuth App client secret.
- `SIGNING_PRIVATE_JWK`: the one-line JSON from `pnpm keygen`, wrapped in single quotes.
- `PAIRWISE_SECRET`: at least 32 high-entropy characters, wrapped in quotes when needed.

Validate the file without sourcing it in a shell:

```sh
pnpm check:config
```

The validator parses only `.dev.vars` into an isolated in-memory map, ignores ambient environment values, trims each parsed value for validation, and never prints configured values.

Initialize local D1 and start the Worker:

```sh
pnpm db:local
pnpm dev
```

Open `http://localhost:8787/demo/` for the built-in PKCE and device demos. The account surface is at `http://localhost:8787/me/`.

`pnpm dev` performs a complete Astro build and regenerates the inline-script CSP hashes before Wrangler starts. It passes `--var ISSUER:http://localhost:8787` to Wrangler, overriding only `ISSUER` for the local process; `ISSUER` is not a secret and does not belong in `.dev.vars`. The production `pnpm deploy` command passes no override and continues to use the canonical HTTPS `ISSUER` from `wrangler.toml`. Local development intentionally does not run a stale build watcher, so restart `pnpm dev` after changing Astro pages or browser scripts.

## Checks

```sh
pnpm check:config
pnpm check
```

`pnpm check` runs TypeScript, the Astro production build with CSP hash generation, all Vitest tests, and `wrangler deploy --dry-run`. Building before tests makes the command reliable in a fresh checkout where `dist/` does not exist. The dry-run syntax is verified against the installed Wrangler CLI.

## Production deployment

The public broker is deployed at:

```text
https://triad-auth-broker.equator-owl-studio.workers.dev
```

Its GitHub OAuth callback is:

```text
https://triad-auth-broker.equator-owl-studio.workers.dev/callback/github
```

The Worker uses the `triad-auth` D1 database and the remote `triad-demo` registration allows only the same-origin `/demo/callback/` URI. Discovery, JWKS, static pages, security headers, and device-code issuance are live.

To set or rotate runtime values, use Wrangler's interactive secret prompt so values do not enter shell history:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put SIGNING_PRIVATE_JWK
pnpm exec wrangler secret put PAIRWISE_SECRET
```

After changing secrets, deploy the canonical configuration:

```sh
pnpm check
pnpm deploy
```

Verify the deployment:

```sh
ISSUER="https://triad-auth-broker.equator-owl-studio.workers.dev"
curl -i "$ISSUER/"
curl -i "$ISSUER/.well-known/openid-configuration"
curl -i "$ISSUER/.well-known/jwks.json"
```

Then complete both flows at `$ISSUER/demo/` and confirm the returned token has `sub === pairwise_sub`, `provider_sub` starts with `prv_<provider>_`, and `account_sub` starts with `acct_`. Requested profile claims must appear only when their scopes were included.

## Revocation behavior

The `/me/` surface can delete a downstream client's consent record. That prevents silent reuse of that consent, but it does not revoke an ID token already issued to the client; ID tokens expire after five minutes. A user can approve the client again later.

Logout deletes the hashed Triad browser session and cookie. It does not revoke previously issued downstream tokens or the user's authorization at an upstream provider. Provider authorization must be revoked through that provider when required.

Authorization codes, device codes, CSRF tokens, and upstream state are one-time and expiry-bound. Upstream access tokens are discarded immediately after resolving the provider identity and requested profile values.

## MVP limitations

- Google, GitHub, and Twitter adapters are supported, but each provider appears only when its complete credential pair is configured.
- There is no cross-provider identity linking, dynamic client registration, account deletion, signing-key rotation, or operator audit UI.
- Client registration and redirect changes are migration/operator tasks.
- Rate limits are single-region D1 counters, not a complete abuse-prevention system.
- Deployment requires a stable hostname, persistent D1, and secret injection. An ephemeral preview is not a valid issuer.
- A protocol and security review is required before accepting real users.

## Stack

- Cloudflare Worker, D1, and static assets
- Astro 7
- Hono and JOSE
- TypeScript 7 and Vitest
- pnpm 11

## License

See [LICENSE](LICENSE).
