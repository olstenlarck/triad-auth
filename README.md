# Triad Auth on Better Auth

A clean-room Triad prototype built on Better Auth 1.7 RC.

It keeps Triad's deterministic, opaque identity model while delegating protocol machinery to Better Auth:

- Google, GitHub, and Twitter login
- OAuth 2.1 and OpenID Connect authorization server
- authorization-code + PKCE
- device authorization
- dynamic client registration
- official CIMD client discovery
- native `private_key_jwt` client authentication
- granular `email`, `handle`, `name`, and `avatar` consent
- direct Cloudflare D1 storage
- no cross-provider account linking
- no public storage or emission of upstream provider user IDs

## Setup

Install Vite+ once, then:

```sh
vp install
cp .dev.vars.example .dev.vars
vp exec wrangler d1 create triad-better-auth
```

Put the returned D1 ID into `wrangler.jsonc`. Generate Better Auth's current RC schema and apply it:

```sh
vp run auth:schema
vp run db:local
```

Start locally:

```sh
vp dev
```

Before deploying, set secrets:

```sh
vp exec wrangler secret put BETTER_AUTH_SECRET
vp exec wrangler secret put TRIAD_ROOT_SECRET
vp exec wrangler secret put GITHUB_CLIENT_ID
vp exec wrangler secret put GITHUB_CLIENT_SECRET
# Repeat for Google and Twitter.
vp run db:remote
vp run deploy
```

## Important prototype boundary

The identity derivations are copied exactly from current Triad. The Better Auth hooks are intentionally isolated in `src/auth.ts` so changes in the 1.7 RC API stay localized.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
