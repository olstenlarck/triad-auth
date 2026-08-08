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

Triad derives `provider_sub`, `account_sub`, and pairwise `sub` values from the dedicated `IDENTIFIER_SECRET`. The
OIDC discovery document advertises pairwise subjects only. Provider accounts remain separate even when their profile
emails match.

The optional provider profile fields (`email`, `email_verified`, `handle`, `name`, and `avatar_url`) are stored only
inside the versioned, encrypted `PROFILE_DATA_KEYRING` envelope. Better Auth-managed session, OAuth, and JWKS records
remain protocol state; upstream provider access, refresh, and ID tokens are removed before account persistence.
The provider account record keeps Better Auth's verified issuer and immutable upstream account ID so later sign-ins
resolve the same account. Those values are not issued to downstream clients; Triad issues its derived identity
claims instead.
The physical `user` table keeps Better Auth's required structural columns, but the user create hook replaces the core
`name`, `email`, `emailVerified`, and `image` values with an empty name, an account-subject placeholder email, `false`,
and an empty image before persistence. No provider profile value is written to those columns.

The signed-in account page can delete the account. Deletion removes the profile envelope, sessions, provider account,
device records, consents, grants, and user-bound token records. Already issued short-lived JWTs may remain valid until
expiry, and deletion does not remove data held by an upstream provider.

Terms and the current data inventory are available at [`/terms`](/terms) and [`/privacy`](/privacy).

## Device authorization

Triad supports two device contracts through Better Auth's shared device-code and approval routes:

- First-party devices use Triad's origin as `client_id` and redeem `/device/token` for a Triad session.
- Registered OAuth clients request approved scopes and resources, then redeem `/oauth2/token` with the RFC 8628
  device-code grant for OAuth tokens.
