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
