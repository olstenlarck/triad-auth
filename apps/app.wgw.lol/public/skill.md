---
name: wgw-git
description: Host, clone, push, review, and merge git repositories on app.wgw.lol, a git platform that runs on Cloudflare. Use it to create repositories, open and merge pull requests, commit files over HTTP without a clone, keep private paths inside a public repository, and read deployment secrets for an environment.
---

# wgw git hosting

app.wgw.lol is plain git over HTTPS plus a JSON API. Every repository lives in its own Cloudflare Durable Object. There is no GitHub underneath.

- Web: `https://app.wgw.lol`
- Git remote: `https://app.wgw.lol/<owner>/<repo>.git`
- API base: `https://app.wgw.lol/api`
- Agent registration: `https://app.wgw.lol/auth.md`

## 1. Get a token

Pick the first option that fits.

1. **A person gives you a key.** They create one at `https://app.wgw.lol/settings`, or run `wgw key create my-agent --scopes read,write --repo owner/repo`. Keys can be limited to one repository and one environment.
2. **The CLI device flow.** Run `wgw login`. It prints a URL and a code. A signed-in person (or an agent with an AgentID session) approves it. The CLI stores a 90-day key in `~/.config/wgw/config.json`.
3. **AgentID.** If you own an AgentMail inbox, open `https://app.wgw.lol/auth/agentid/start?login_hint=<inbox>` in your browser. You get an agent account and a browser session; then approve a `wgw login` code with it.
4. **auth.md.** Register yourself with no prior credentials. Follow `https://app.wgw.lol/auth.md`. Before a person claims you, you can read public repositories. After the claim, you act as that person with `read write` scopes for one hour per access token.

Send the token as `Authorization: Bearer <token>`. Git sends it as the HTTP basic password; the username is ignored.

## 2. Install the CLI (optional)

```sh
curl -fsSL https://app.wgw.lol/install.sh | sh
wgw login            # or: wgw login --token "$WGW_TOKEN"
```

The CLI is one file with no dependencies. It needs Node 20+ or Bun. `WGW_TOKEN` overrides the stored key. Every command takes `-R owner/repo`; inside a clone it reads the git remote.

## 3. Git

```sh
wgw repo create demo                 # public; add --private for a private repository
git remote add wgw https://app.wgw.lol/<you>/demo.git
git push wgw main

wgw clone owner/repo                 # members get private paths too
```

Without the CLI:

```sh
git -c http.proactiveAuth=basic clone "https://x:${WGW_TOKEN}@app.wgw.lol/owner/repo.git"
```

Use `http.proactiveAuth=basic`. Public repositories answer anonymous requests, so plain git never sends your token and you get the public view. `wgw login` and `wgw setup-git` set it for app.wgw.lol for you.

Supported: clone, fetch, pull, push, force push, shallow clones (`--depth`), tags, branch deletes, atomic pushes. When the branch moved after your fetch, the push fails with `fetch first`.

## 4. Commit without a clone

```sh
curl -s https://app.wgw.lol/api/repos/OWNER/REPO/commits \
  -H "Authorization: Bearer $WGW_TOKEN" -H 'content-type: application/json' \
  -d '{
    "branch": "agent/fix-typo",
    "message": "docs: fix a typo",
    "expected_sha": "<current branch tip, or omit>",
    "files": [
      { "path": "README.md", "content": "# Title\n" },
      { "path": "logo.png", "content": "<base64>", "encoding": "base64" },
      { "path": "old.txt", "delete": true }
    ]
  }'
```

The branch is created when it does not exist. With `expected_sha`, the commit fails with 409 when someone else moved the branch first. Use it when several agents work on one branch.

CLI: `wgw commit --branch agent/fix -m "docs: fix" README.md=./README.md`.

## 5. Pull requests

```sh
wgw pr create --head agent/fix-typo --title "Fix a typo" --body "One word."
wgw pr list
wgw pr diff 3          # unified diff, ready for review
wgw pr summary 3       # Workers AI summary of the diff
wgw pr comment 3 --body "Looks right."
wgw pr merge 3         # fast-forward when possible, else a merge commit
```

Merges run on the server. A path changed differently on both sides is a conflict; the merge fails with 409 and names the paths. Rebase locally and push again.

## 6. Private paths in a public repository

Add `.gitprivate` at the repository root. The syntax is like `.gitignore`:

```
security/            # a directory
*.pem                # any depth
docs/embargo-*.md    # anchored at the root because it has a slash
```

Members (the owner and collaborators) see everything, over git and over the API. Everyone else sees a public history where those paths never existed. Each commit uses its own `.gitprivate`, so:

- Earlier public commit hashes never change when you add rules later.
- A commit that only touches private paths is left out of the public history.
- Deleting a line publishes that path from the next commit on. This is how a security advisory goes public after the fix ships.
- Commit messages stay visible. Keep embargoed details out of them.

Check what the public sees: `curl -s https://app.wgw.lol/api/repos/OWNER/REPO/tree` without a token.

## 7. Environments and secrets

```sh
wgw env create production --kind production     # kinds: production, staging, preview, development
wgw secret set DATABASE_URL --env production     # reads the value from stdin
wgw secret set LOG_LEVEL --plain info            # repository-wide, not secret
wgw env pull production > .env                   # needs a key with the secrets scope
```

Repository values apply to every environment and environment values override them. Secret values are sealed with AES-256-GCM. Only `GET /api/repos/OWNER/REPO/env?environment=NAME` opens them, it needs write access plus the `secrets` scope, and every read is logged in the repository activity.

## 8. API reference

All paths start with `https://app.wgw.lol/api`. Errors are `{"error": "<code>", "message": "<text>"}`.

| Method and path | What it does |
| --- | --- |
| `GET /me` | The token's account and scopes |
| `GET /repos?owner=` · `POST /repos` | List repositories · create one: `name`, `description`, `visibility`, `import_url` |
| `GET` · `PATCH` · `DELETE /repos/:owner/:repo` | Read, update (`description`, `visibility`, `default_branch`), delete |
| `POST /repos/:owner/:repo/fork` | Fork; outsiders get only the public projection |
| `GET /repos/:owner/:repo/refs` | Branches and tags |
| `POST /repos/:owner/:repo/branches` · `DELETE …/branches/:name` | Create (`name`, `from`) or delete a branch |
| `GET /repos/:owner/:repo/tree?ref=&path=` | Directory listing |
| `GET /repos/:owner/:repo/blob?ref=&path=` · `GET …/raw?ref=&path=` | File as JSON (text) · raw bytes |
| `GET /repos/:owner/:repo/commits?ref=&path=&limit=` | History, newest first |
| `GET /repos/:owner/:repo/commits/:sha` · `POST …/commits` | One commit with its diff · commit files |
| `GET /repos/:owner/:repo/compare?base=&head=` | Commits, file diffs, mergeability |
| `GET` · `POST /repos/:owner/:repo/pulls` | List (`state=open,merged,closed,all`) · open (`title`, `head`, `base`, `body`) |
| `GET` · `PATCH /repos/:owner/:repo/pulls/:n` | Read with diff · update `title`, `body`, `state` |
| `GET /repos/:owner/:repo/pulls/:n/diff` | Unified diff as text |
| `POST /repos/:owner/:repo/pulls/:n/merge` · `…/summary` | Merge · AI summary |
| `GET` · `POST /repos/:owner/:repo/pulls/:n/comments` | Comments |
| `GET` · `PUT` · `DELETE /repos/:owner/:repo/collaborators/:handle` | Collaborators (`role`: read, write, admin) |
| `GET` · `POST /repos/:owner/:repo/environments` · `DELETE …/environments/:name` | Environments and their variable names |
| `PUT` · `DELETE /repos/:owner/:repo/variables/:NAME` | Set (`value`, `secret`, `environment`) or delete |
| `GET /repos/:owner/:repo/env?environment=&format=dotenv` | Opened values for one environment |
| `GET /repos/:owner/:repo/events` | Pushes, merges, secret reads |
| `GET` · `POST /keys` · `DELETE /keys/:id` | API keys (`name`, `scopes`, `repo`, `environment`, `expires_in_days`) |
| `POST /device/code` · `POST /device/token` | CLI device flow |

Scopes: `read` (private repositories you can see), `write` (push, pull requests, commits), `admin` (settings, collaborators, environments, keys), `secrets` (open secret values).

## 9. Limits

- Imports stop at 80 MB of packed history. Cloudflare caps one request body at 100 MB.
- Blobs over 1 MB are stored in R2; the web view links to the raw file for them.
- The service runs on the Workers free plan: 100,000 requests a day across everyone.
