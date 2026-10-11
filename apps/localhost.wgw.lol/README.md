# localhost

localhost is a git host at https://localhost.wgw.lol. It was built for Cloudflare's ["build the next Git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) competition. Cloudflare Artifacts, the managed git storage from that post, is Workers Paid only and this account is on the free plan, so the git server here is written from scratch and runs inside Durable Objects. There is one Worker and one environment. `deploy:nightly` deploys production on every merge to `master`.

Agents get the same access humans do. `/skill.md` tells one how to use the API, `/auth.md` tells one how to get an account, and `cli/lh.ts` is a one-file CLI with no dependencies.

## What Cloudflare runs it

All of it is in `cloudflare.config.ts`. The Worker is `localhost-wgw-lol`, served on the zone route `localhost.wgw.lol/*`.

| Binding | Product | What it stores or does |
| --- | --- | --- |
| `REPOS` | Durable Object `RepoObject`, SQLite-backed | One object per repository. Git objects as zlib streams, refs, HEAD, the snapshot cache, and import progress. The git protocol runs in here. |
| `DB` | D1 `localhost-wgw-lol` | Users, identities, sessions, tokens, device codes, agent registrations, repos, collaborators, path rules, environments and their variables, pull requests and comments, the event feed |
| `KV` | Workers KV | Pending OAuth logins, keyed by `state`, for 10 minutes |
| `BLOBS` | R2 bucket `localhost-wgw-lol` | Compressed objects above 1.5 MB at `objects/<repo>/<sha>`, and every received packfile at `packs/<repo>/<timestamp>.pack` |
| `EVENTS` | Queue `localhost-wgw-lol-events` | Push, pull request, and repo created or imported events. The consumer writes the activity feed. |
| `AI` | Workers AI | One-line push summaries for the feed, and pull request summaries on request. Model `@cf/meta/llama-3.1-8b-instruct-fast`. |
| `GIT_RATE_LIMIT` | Rate limiting | 600 git requests per 60 seconds per user, or per IP when anonymous |
| `ANALYTICS` | Analytics Engine `localhost_wgw_lol` | One data point per git advertise, fetch, or push |
| `ASSETS` | Static assets | The Vite client bundle. HTML and 404 handling are off, so every other path reaches the Worker. |

Plain text vars: `APP_ORIGIN`, `TRIAD_ISSUER` (`https://triad-auth-nightly.wgw.lol`), `AGENTID_ISSUER` (`https://auth.agentid.com`), and `COMMIT_SHA`, which the deploy task sets and `/healthz` reports. Secrets: `SESSION_SECRET`, `ENCRYPTION_KEY`, `JWT_PRIVATE_JWK`.

## How git works here

`src/git` is a smart HTTP v1 server that does not shell out to git.

| File | What it does |
| --- | --- |
| `pktline.ts` | pkt-line reader and writer, side-band-64k framing |
| `objects.ts` | SHA-1 hashing, parse and serialize commits, trees, and tags |
| `pack.ts` | Packfile parse with ofs-delta and ref-delta, checksum check, streaming pack writer |
| `protocol.ts` | Ref advertisement, upload-pack, receive-pack |
| `walk.ts` | Log, merge base, ancestor checks, and the object plan for a pack, with depth |
| `tree.ts` | Tree diff, path lookup, filtered tree copies, single-path writes |
| `merge.ts` | Three-way merge at the tree level |
| `store.ts` | The `Repository` interface and an in-memory one for tests |

upload-pack advertises `side-band-64k thin-pack ofs-delta shallow no-progress` and no `multi_ack`. The server answers the first common commit with one `ACK`, or `NAK`, then streams the pack. `deepen` works. The plan cuts the walk at the requested generation and sends `shallow` lines. receive-pack advertises `report-status side-band-64k delete-refs ofs-delta`, reports per ref, rejects non-fast-forward updates with `ng fetch first`, and refuses to delete the default branch. Ref updates are compare-and-set inside one SQLite transaction, so two pushes cannot interleave.

Objects live in the Durable Object's SQLite as zlib streams. When a pack arrives, the parser keeps the zlib bytes of every non-delta entry and stores them as they came. Delta entries are resolved and compressed once. When a clone is served, `writePack` reads the stored bytes and writes them straight into the outgoing pack. Nothing is recompressed on either path. Thin packs resolve ref-delta bases from the repository.

The Worker never parses a pack. `src/git-http.ts` authenticates, checks access and the rate limit, computes the hidden paths, and forwards the request body to the Durable Object with `stub.fetch` so it streams. The DO answers a push with an `x-lh-push` header, and the Worker turns that into a queue event and a `pushed_at` update.

`test/git-http.test.ts` starts a Node HTTP server over the in-memory repository (`test/git-server.ts`) and drives it with the real `git` binary: push, clone, `fsck`, an incremental thin pack, a pull with negotiation, a `--depth 1` clone, tags, branch deletion, and a rejected non-fast-forward push. `test/git-core.test.ts` covers delta application, pack round trips, tree diff and filter, merge, and log. Both run in plain Node, and `git` must be on `PATH`.

## Auth

Humans sign in through Triad. localhost is an OIDC client with a CIMD document at `/oauth-client.json`. That URL is the `client_id`, with PKCE and no client secret. Triad offers more identity sources, but localhost accepts only Google and passkey. The callback checks that `provider_sub` starts with `pid_google_` or `pid_passkey_` and rejects anything else. Google logins also need a verified email.

Agents have three ways in.

| Method | Flow | Who owns the token |
| --- | --- | --- |
| AgentID | OIDC with `client_id` set to the app origin, an open client. The user gets `kind: agent` and the owner's email is kept. | The agent, as its own account |
| auth.md | `POST /agent/identity` with `{"type":"anonymous"}` returns a claim token and an ES256 assertion. `POST /agent/identity/claim` returns a six-digit code and a login URL. A human signs in and types the code at `/claim`. The agent polls `/oauth2/token` with the claim grant, and later refreshes with the `jwt-bearer` grant. | The human who claimed it |
| Device flow | RFC 8628. `POST /oauth2/device_authorization`, approve at `/device`, poll `/oauth2/token` with the `device_code` grant. This is what `lh login` does. | The human who approved |

Discovery lives at `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/.well-known/jwks.json`. `JWT_PRIVATE_JWK` signs the assertions.

API tokens start with `lh_` and are 30 random bytes, base64url. D1 keeps the SHA-256 hash and the first 11 characters. The plaintext is shown once. Send one as `Authorization: Bearer` or as the HTTPS password for git with any username. Only a browser session can mint tokens through `POST /api/user/tokens`, so a leaked token cannot mint more. Scopes: `repo:read`, `repo:write`, `repo:admin`, `env:read`, `env:write`, `user:read`.

## Visibility

A repo is `public` or `private`. Path rules then override that per prefix. Owners and collaborators (`read`, `write`, `admin`) always see everything.

In a public repo, a rule like `security/ = private` hides that prefix from readers without a role. The API and UI drop those paths. For git, `RepoObject.publicView` rewrites every ref tip. `snapshotCommit` filters the hidden prefixes out of the tree and writes one commit with no parents and the message suffix `Public snapshot`. The snapshot has its own remote, `<owner>/<repo>.public.git`, which is read-only. The full remote, `<owner>/<repo>.git`, answers 401 to anonymous callers once a private rule exists, because git only sends credentials after a challenge and a collaborator must never receive the snapshot by accident. Upload-pack also rejects wants that are not advertised tips, so the real history cannot be requested by sha. Snapshots are cached per tip and rule set in the DO's `meta` table, so repeated clones reuse the same objects. Collaborators clone full history.

A private repo can carry `public` rules. The tree, blob, and raw API routes use the `exposed` access level in `src/api/http.ts`, which admits an anonymous caller only when such a rule exists and then filters to those paths. Every other route, and git, still answers 401. The web UI has no page for this view yet; the API is the way to read an exposed file.

## Environments and secrets

Each repo has named environments with `UPPER_SNAKE_CASE` variables. Values are stored as `v1.<iv>.<ciphertext>`: AES-256-GCM with a 12-byte IV, under a key derived from `ENCRYPTION_KEY` by SHA-256. Listing names needs a role plus `env:read`. `?reveal=1` decrypts, and variables stored with `secret: false` decrypt without it. Writes need `write` plus `env:write`. Deleting an environment needs `admin`.

## Local development

```sh
pnpm install
cp .env.example .env
pnpm run db:migrate:local
pnpm run dev
```

`.env` needs three values. Generate `SESSION_SECRET` and `ENCRYPTION_KEY` with two separate runs of:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Generate `JWT_PRIVATE_JWK`, an ES256 private key as one line of JSON, with:

```sh
bun -e 'const {generateKeyPair, exportJWK} = await import("jose"); const {privateKey} = await generateKeyPair("ES256", {extractable: true}); console.log(JSON.stringify({...await exportJWK(privateKey), kid: crypto.randomUUID().slice(0,8)}))'
```

`pnpm run dev` runs `cf dev`, with local D1 and Durable Object storage in `.cloudflare/state/`. `db:migrate:local` applies `migrations/` to that storage. The tests do not need `cf` or a Cloudflare account.

Checks, from the repository root:

```sh
turbo run check --filter=localhost.wgw.lol
turbo run test --filter=localhost.wgw.lol
turbo run build --filter=localhost.wgw.lol
```

## Deployment and secrets

RWX runs `deploy:nightly` after `check`, `test`, and `build` pass on `master`, for the apps that push changed. The script applies pending D1 migrations with `cf d1 migrations apply`, then runs `cf deploy`. `COMMIT_SHA` comes from the task and ends up in `/healthz`. Do not run the deploy script locally unless asked.

The three secrets are set once on the Worker `localhost-wgw-lol` and persist across deploys. `cf` cannot set a single secret yet, so use `npx wrangler secret put <NAME> --name localhost-wgw-lol`. The deploy script never touches them.

| Resource | Name | Created |
| --- | --- | --- |
| Worker | `localhost-wgw-lol` | By the first `cf deploy` |
| Route | `localhost.wgw.lol/*` on zone `wgw.lol` | By `cf deploy`, from the config |
| Durable Object | `RepoObject`, SQLite | By `cf deploy`, from `exports.durableObject` in the config |
| D1 | `localhost-wgw-lol` (`ee6567b0-3234-4fcc-87fe-d9e6ff0c171c`) | Once, by hand |
| KV | `fda4c4aebd2848858a235cec994cb52e` | Once, by hand |
| R2 | `localhost-wgw-lol` | Once, by hand |
| Queue | `localhost-wgw-lol-events` | Once, by hand |

## The CLI

`cli/lh.ts` is one file with no dependencies. Run it with `bun cli/lh.ts` or `pnpm run lh`. Node 22 works too. Start with `bun cli/lh.ts login`.

```text
lh login                      device flow; stores the token in ~/.config/lh/credentials.json
lh whoami
lh repo list | create <name> [--private] [--import <https url>] | delete <owner/repo>
lh clone <owner/repo> [dir]   clones with the stored token
lh pr list <owner/repo> | create <owner/repo> --head <branch> [--base <branch>] --title <t> [--body <b>]
lh pr merge <owner/repo> <number> | close <owner/repo> <number>
lh env list <owner/repo> | get <owner/repo> <env> | set <owner/repo> <env> KEY=value [KEY=value...]
lh visibility <owner/repo> [set <pattern> public|private] [unset <pattern>]
lh token create <name> [--scopes a,b] | list | revoke <id>
lh api <method> <path> [json]  raw call
```

`token create` is in that list but not implemented. Only a browser session may mint a token, so tokens come from `lh login` or from Settings, Tokens. `LH_ORIGIN` points the CLI at another deployment and `LH_TOKEN` overrides the stored token.

The Worker serves the same documents an agent reads.

| URL         | Content                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `/skill.md` | How to authenticate and use the API and git, with the full route table |
| `/auth.md`  | The anonymous registration and claim ceremony, step by step            |
| `/llms.txt` | Index of the above plus the discovery documents                        |

## Known limits of the prototype

The free plan sets the hard numbers.

| Limit | Effect |
| --- | --- |
| Durable Object, 30 s CPU per request | A single push or import tops out around a few hundred thousand objects. Pushes above about 60 MB fail; split them. |
| SQLite row, 2 MB | Compressed blobs above 1.5 MB go to R2 instead |
| Worker, 10 ms CPU | The Worker never parses a pack. Everything heavy runs in the DO. |
| Durable Object, 100k rows written per day | Shared across every repo. One big import can use a day's quota. |

The rest are design choices for now.

- Protocol v1 only. A v2 client falls back on its own.
- Served packs carry no deltas. Every object goes out as stored, so a clone is bigger than git would make it. The trade is zero compression work in the DO.
- Merges work at the tree level. Two sides touching the same file is a conflict. There is no line merge.
- No rename detection. A rename shows as a removal and an addition.
- No markdown rendering. A README shows as plain text.
- Import reads public https remotes only, with a 200 MB cap on the fetched pack.
