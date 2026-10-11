---
name: localhost
description: Use localhost.wgw.lol, a git host on Cloudflare, from an agent. Covers auth, cloning, pushing, pull requests, environments, and private paths.
---

# localhost

localhost is a git host at `https://localhost.wgw.lol`. Everything the web UI does, the REST API does too. Auth is a bearer token.

## Get a token

Pick one:

1. **Device flow** (you are running next to a human with a browser). Run `bun cli/lh.ts login` or do it by hand: `POST /oauth2/device_authorization` (form, optional `scope`), show the human `verification_uri_complete`, poll `POST /oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=...` until you get `access_token`.
2. **auth.md** (the human is elsewhere). Follow `https://localhost.wgw.lol/auth.md`.
3. **AgentID** (you have an AgentMail inbox). Open `https://localhost.wgw.lol/auth/login?provider=agentid` in a browser session and approve from your inbox. You get your own account, not the human's.
4. A human creates a token under Settings, Tokens and gives it to you.

Tokens start with `lh_`. Scopes: `repo:read repo:write repo:admin env:read env:write user:read`.

## Call the API

```sh
H="Authorization: Bearer $LH_TOKEN"
curl -s -H "$H" https://localhost.wgw.lol/api/user
curl -s -H "$H" https://localhost.wgw.lol/api/repos
curl -s -H "$H" -X POST https://localhost.wgw.lol/api/repos \
  -H 'content-type: application/json' \
  -d '{"name":"demo","visibility":"private","default_branch":"master"}'
```

Repository routes live under `/api/repos/:owner/:repo`:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | metadata, refs, permissions, stats, import progress |
| PATCH | `/` | `description`, `visibility`, `default_branch` |
| DELETE | `/` | admin only |
| GET | `/refs` | branches and tags |
| GET | `/commits?ref=&limit=&skip=` | history |
| GET | `/commits/:sha` | one commit with its diff |
| GET | `/tree/:ref/:path` | directory listing |
| GET | `/blob/:ref/:path` | file as JSON (`text` is null for binary) |
| GET | `/raw/:ref/:path` | file bytes |
| PUT | `/contents/:path` | `{content, message, branch}` writes one file and commits |
| DELETE | `/contents/:path` | removes one file and commits |
| POST | `/branches` | `{name, from}` |
| DELETE | `/branches/:name` |  |
| GET | `/compare/:base...:head` | changes and commits between refs |
| GET, POST | `/pulls` | `{title, body, base, head}` |
| GET | `/pulls/:n` | pull request with diff and comments |
| POST | `/pulls/:n/comments` | `{body}` |
| POST | `/pulls/:n/merge` | fast-forward or merge commit; 409 with `conflicts` on conflict |
| POST | `/pulls/:n/close` |  |
| POST | `/pulls/:n/summarize` | Workers AI drafts a summary |
| GET | `/environments` | names and variable keys |
| PUT | `/environments/:name` | create |
| GET | `/environments/:name/vars?reveal=1` | decrypted values with `env:read` |
| PUT | `/environments/:name/vars/:KEY` | `{value, secret}` |
| DELETE | `/environments/:name/vars/:KEY` |  |
| GET | `/visibility` | repo visibility and path rules |
| PUT | `/visibility/rules` | `{pattern, visibility}` |
| DELETE | `/visibility/rules/:pattern` |  |
| GET, PUT, DELETE | `/collaborators/:handle` | `{role}` is read, write, or admin |
| GET | `/events` | activity feed |

Errors are `{"error": "<code>", "message": "..."}`. A 401 includes `WWW-Authenticate` with the resource metadata URL.

## Git

```sh
git clone https://x:$LH_TOKEN@localhost.wgw.lol/<owner>/<repo>.git
git push origin master
```

Smart HTTP v1. `--depth` works. Pushes larger than about 60 MB will fail; split them.

Public repositories clone without a token. A public repository with private path rules has two remotes: `<owner>/<repo>.git` holds the full history and demands credentials, and `<owner>/<repo>.public.git` is read-only and serves one snapshot commit per branch with the private paths removed. Git sends credentials only after a 401, so the split keeps a collaborator from getting the snapshot by accident. The repo info endpoint returns the right `clone_url` for the caller plus `public_clone_url`.

## Private paths in public repos

A repository is `public` or `private`, then path rules override that per prefix:

- public repo with rule `security/ = private`: readers who are not collaborators never see `security/` in the UI, API, or clone.
- private repo with rule `SECURITY.md = public`: anyone can read that one file through the API and UI.

Set rules with `PUT /visibility/rules`.

## Environments

Each repo has named environments (`production`, `staging`, anything). Variables are encrypted at rest. Reading values needs `env:read` plus a role on the repo. Agents deploying from a clone read them with:

```sh
curl -s -H "$H" "https://localhost.wgw.lol/api/repos/o/r/environments/production/vars?reveal=1"
```

## Import from GitHub

`POST /api/repos` with `import_from: "https://github.com/owner/repo"`. Import runs inside the repository's Durable Object. Poll `GET /api/repos/:owner/:repo` and read `import.status`.

## Limits worth knowing

Workers free plan. One Durable Object per repository, SQLite-backed. Files above 1.5 MB compressed go to R2. The Durable Object has 30 seconds of CPU per request, which bounds a single push or import to roughly a few hundred thousand objects.
