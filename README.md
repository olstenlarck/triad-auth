# Triad Auth Broker

Triad is a small, inspectable OAuth/OIDC broker for GitHub authentication. It runs as one Cloudflare Worker with D1 and static Astro assets, and includes authorization-code PKCE and device-flow demos.

This repository is an MVP, not a general-purpose identity platform. It deliberately exposes the identity semantics a downstream client receives and does not collect profile data.

## Identity claims

Every ID token uses the app-scoped identity as both `sub` and `pairwise_sub`.

- `pairwise_sub`: an HMAC-derived identifier unique to the broker account and downstream `client_id`.
- `account_sub`: a random broker account identifier, stable across receiving Triad clients.
- `provider_sub`: the globally correlatable GitHub identity, formatted as `github:<numeric-id>`.

Triad does not request GitHub profile scopes and does not persist or emit email, login, name, avatar, or GitHub access tokens. Email must never be used as an identity key.

## Supported flows

- Authorization Code with mandatory S256 PKCE
- OAuth Device Authorization Grant-style flow
- OIDC discovery at `/.well-known/openid-configuration`
- ES256 public keys at `/.well-known/jwks.json`

Downstream clients are registered in D1 with exact redirect URI and provider allowlists. There is no dynamic client registration.

## Requirements

- Node.js 24 or a compatible release with `process.loadEnvFile`
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

The validator uses Node's dotenv loader, prints variable names and generic validation errors only, and never prints configured values.

Initialize local D1 and start the Worker:

```sh
pnpm db:local
pnpm dev
```

Open `http://localhost:8787/demo/` for the built-in PKCE and device demos. The account surface is at `http://localhost:8787/me/`.

`pnpm dev` performs a complete Astro build and regenerates the inline-script CSP hashes before Wrangler starts. It intentionally does not run a stale build watcher. Restart `pnpm dev` after changing Astro pages or browser scripts.

## Checks

```sh
pnpm check:config
pnpm check
```

`pnpm check` runs TypeScript, all Vitest tests, the Astro production build with CSP hash generation, and `wrangler deploy --dry-run`. The dry-run syntax is verified against the installed Wrangler 4.107.1 CLI.

## Production runbook

Task 8 intentionally commits neither a D1 database ID nor a production issuer. Task 10 must establish both using real Cloudflare results. In the commands and instructions below:

- `<D1_DATABASE_ID>` means the exact ID returned by Cloudflare.
- `<ISSUER>` means the exact stable HTTPS Worker origin, without a trailing slash.

1. Authenticate Wrangler and create the database:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create triad-auth
```

2. Add `database_id = "<D1_DATABASE_ID>"` to the existing `[[d1_databases]]` block in `wrangler.toml`. Do not deploy with an invented value.

3. Upload all runtime values through Wrangler's interactive secret prompt so values do not enter shell history:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put SIGNING_PRIVATE_JWK
pnpm exec wrangler secret put PAIRWISE_SECRET
```

4. Run an initial deployment to establish the stable Worker hostname. Do not use this deployment for authentication yet because the committed issuer is local-only:

```sh
pnpm deploy
```

5. Set `ISSUER` in `wrangler.toml` to `"<ISSUER>"`. Change the `triad-demo` redirect registration in the migration to `<ISSUER>/demo/callback/`, and set the GitHub OAuth App callback to `<ISSUER>/callback/github`.

6. Apply the production migration, run all checks, and deploy the canonical configuration:

```sh
pnpm db:remote
pnpm check
pnpm deploy
```

7. Verify the exact deployment:

```sh
ISSUER="<ISSUER>"
curl -i "$ISSUER/"
curl -i "$ISSUER/.well-known/openid-configuration"
curl -i "$ISSUER/.well-known/jwks.json"
```

Then complete both flows at `<ISSUER>/demo/` and confirm the returned token has `sub === pairwise_sub`, `provider_sub` starts with `github:`, and `account_sub` starts with `acct_`.

## Revocation behavior

The `/me/` surface can delete a downstream client's consent record. That prevents silent reuse of that consent, but it does not revoke an ID token already issued to the client; ID tokens expire after ten minutes. A user can approve the client again later.

Logout deletes the hashed Triad browser session and cookie. It does not revoke previously issued downstream tokens or the user's authorization of the GitHub OAuth App. GitHub App authorization must be revoked through GitHub when required.

Authorization codes, device codes, CSRF tokens, and upstream state are one-time and expiry-bound. GitHub access tokens are discarded immediately after resolving the immutable numeric user ID.

## MVP limitations

- GitHub is the only upstream provider.
- There is no email/profile scope, identity linking, dynamic client registration, account deletion, signing-key rotation, or operator audit UI.
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
