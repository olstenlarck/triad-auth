# Triad Better Auth

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

## Deployment isolation

This branch targets the `triad-better-auth` Worker. Its Better Auth D1 database and migrations will be created separately during implementation. Never point this branch at the existing `triad-auth-broker` Worker or `triad-auth` D1 database.

## Data and identity boundaries

Triad derives `provider_sub`, `account_sub`, and pairwise `sub` values from the dedicated `IDENTIFIER_SECRET`. The
OIDC discovery document advertises pairwise subjects only. Provider accounts remain separate even when their profile
emails match.

The optional provider profile fields (`email`, `email_verified`, `handle`, `name`, and `avatar_url`) are stored only
inside the versioned, encrypted `PROFILE_DATA_KEYRING` envelope. Better Auth-managed session, OAuth, and JWKS records
remain protocol state; upstream provider access, refresh, and ID tokens are removed before account persistence.

The signed-in account page can delete the account. Deletion removes the profile envelope, sessions, provider account,
device records, consents, grants, and user-bound token records. Already issued short-lived JWTs may remain valid until
expiry, and deletion does not remove data held by an upstream provider.

Terms and the current data inventory are available at [`/terms/`](/terms/) and [`/privacy/`).
