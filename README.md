# Triad Auth

This branch rebuilds Triad as a Better Auth OAuth/OIDC authorization server. The existing custom implementation remains preserved on `main` and continues to use its original Worker and D1 database.

The visual application is retained as the product baseline: the landing page, demo, consent, account, and device surfaces keep Triad's typography, layout, and interaction language while their backend integration is replaced.

The authorization-server design is documented in `docs/superpowers/specs/2026-07-14-better-auth-authorization-server-design.md`. Numbered implementation plans under `docs/superpowers/plans/` define one focused worktree each.

## Local commands

```sh
vp install
vp run dev
vp run check
vp run build
```

## Deployment

Production and staging use one `triad-auth` Worker and one `triad-auth` D1 database. The `prod` branch deploys the
production version, while `main` uploads the stable staging preview at
`staging-triad-auth.equator-owl-studio.workers.dev`. Other branches do not deploy.

See [`DEPLOY.md`](./DEPLOY.md) for first-time setup, required secrets, and Cloudflare Workers Builds configuration.

## Data and identity boundaries

Triad derives provider and pairwise subjects from the dedicated `IDENTIFIER_SECRET`. Passkey account subjects are
SHA-256 digests of their immutable canonical usernames. The OIDC discovery document advertises pairwise subjects
only. Provider accounts remain separate even when their profile emails match.

The optional provider profile fields (`email`, `email_verified`, `handle`, `name`, and `avatar_url`) are stored only
inside the versioned user `encryptedData` envelope. `ENCRYPTION_SECRETS` supplies its encryption. Better Auth-managed
wallet, passkey, session, OAuth, and JWKS records remain protocol state. Better Auth owns ES256 signing and persists
its JWKS; Triad does not accept a separate signing key secret. Upstream provider access, refresh, and ID tokens are
removed before account persistence.

Social provider account records keep Better Auth's verified issuer and immutable upstream account ID so later sign-ins
resolve the same account. Those values are not issued to downstream clients; Triad issues derived identity claims.

Ethereum identities use the SHA-256 digest of the lowercased address as their immutable upstream input, producing
`pid_ethereum_*` and `acc_*` subjects without exposing the address by default. A client can request the explicit
`wallet` scope to receive it. Passkey identities require a PRF-capable, user-verified ES256/P-256 credential. Each
registration combines a user-selected name with a six-character CUID2 suffix. The SHA-256 digest of that immutable
canonical username produces the `acc_*` subject and WebAuthn user handle, while the canonical public key remains the
input for `pid_passkey_*`. Triad stores the canonical username as the encrypted profile handle and makes it available
as `preferred_username` only through the consented `handle` scope. The credential ID and public key are available only
through the consented `cred` and `pubkey` claims. Better Auth retains wallet addresses, credential IDs, and public keys
in the credential tables it uses to authenticate them. Triad also retains the canonical passkey username and its
account mapping for uniqueness. Every passkey credential is its own account, and credential linking is disabled.
The physical `user` table keeps Better Auth's required structural columns, but the user create hook replaces the core
`name`, `email`, `emailVerified`, and `image` values with an empty name, an account-subject placeholder email, `false`,
and an empty image before persistence. No provider profile value is written to those columns.

Rate-limit buckets are HMAC-derived with `RATE_LIMIT_SECRET` from Better Auth's normalized IP-and-path key. D1 receives
only the opaque digest, request count, and timestamp. Session rows retain Better Auth's generated request-metadata
columns, but create and update hooks always persist `NULL` for `ipAddress` and `userAgent`.

The signed-in account page can delete the account. Deletion removes the profile envelope, sessions, provider account,
device records, consents, grants, and user-bound token records. Already issued short-lived JWTs may remain valid until
expiry, and deletion does not remove data held by an upstream provider.

Terms and the current data inventory are available at [`/terms`](/terms) and [`/privacy`](/privacy).

## Device authorization

Triad supports two device contracts through Better Auth's shared device-code and approval routes:

- First-party devices use Triad's origin as `client_id` and redeem `/device/token` for a Triad session.
- Registered OAuth clients request approved scopes and resources, then redeem `/oauth2/token` with the RFC 8628
  device-code grant for OAuth tokens.
