#!/usr/bin/env bash
# Runs Socket Optimize from the RWX socket-optimize task. Verified overrides are pushed straight to
# master by the PAT owner, a repository admin, so the push is a real push that runs ci and needs
# no pull request. When the overrides fail verification, the diff is opened as a pull request that
# needs attention. When there is nothing to push, an issue links the failed run.

set -uo pipefail

branch=socket-optimize
attention_title="socket optimize: needs attention"
failure_title="socket optimize: run failed"
remote="https://x-access-token:${GITHUB_TOKEN}@github.com/tunnckoCoreHQ/monarch.git"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

open_failure_issue() {
  existing=$(gh issue list --repo tunnckoCoreHQ/monarch --state open --search "\"$failure_title\" in:title" --json number,title --jq ".[] | select(.title == \"$failure_title\") | .number" | head -1)
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo tunnckoCoreHQ/monarch --body "Failed again: $RWX_TASK_URL"
  else
    gh issue create --repo tunnckoCoreHQ/monarch --title "$failure_title" \
      --body "Socket Optimize failed before producing any changes: $RWX_TASK_URL

Fix the cause, then rerun it with \`rwx dispatch monarch-socket-optimize --ref master\` or from the RWX dashboard."
  fi
  exit 1
}

open_attention_pr() {
  # Commit whatever exists if the run failed before the commit.
  git add -A
  git diff --cached --quiet || git commit --no-verify -m "chore(deps): apply socket optimize overrides"
  git push --force "$remote" "HEAD:refs/heads/$branch"
  if gh pr view "$branch" --repo tunnckoCoreHQ/monarch --json number > /dev/null 2>&1; then
    gh pr comment "$branch" --repo tunnckoCoreHQ/monarch --body "Verification failed again: $RWX_TASK_URL"
  else
    gh pr create --repo tunnckoCoreHQ/monarch --base master --head "$branch" \
      --title "$attention_title" \
      --body "Socket Optimize produced overrides that failed verification: $RWX_TASK_URL

Read the failing check, point the broken override back at the original package in pnpm-workspace.yaml (optimize keeps any override that is not an @socketregistry spec), or fix the code the replacement exposed. Then approve and merge."
  fi
  exit 1
}

pnpm exec socket optimize || open_failure_issue

# Socket CLI 1.1.167 writes overrides to package.json, a field pnpm 11 no longer reads. Move them
# to pnpm-workspace.yaml so they take effect. Keys are quoted because scoped names start with "@".
# An entry already in the overrides block is replaced, so a changed spec is kept. Delete this
# block once Socket writes the workspace file itself; its unreleased source does.
if jq -e '.pnpm.overrides' package.json > /dev/null; then
  grep -q '^overrides:' pnpm-workspace.yaml || printf '\noverrides:\n' >> pnpm-workspace.yaml
  existing=$(awk '/^overrides:/ { block = 1; next } /^[^ ]/ { block = 0 } block && /^  / { sub(/^  "?/, ""); sub(/"?:.*/, ""); print }' pnpm-workspace.yaml)
  jq -r '.pnpm.overrides | to_entries[] | "\(.key)\t\(.value)"' package.json |
    while IFS=$'\t' read -r name spec; do
      if grep -qxF "$name" <<< "$existing"; then
        pattern=$(printf '%s' "$name" | sed 's/[.[*^$]/\\&/g')
        sed -i "/^overrides:/,/^[^ ]/ s|^  \"\\{0,1\\}$pattern\"\\{0,1\\}:.*|  \"$name\": \"$spec\"|" pnpm-workspace.yaml
      else
        sed -i "/^overrides:/a\\  \"$name\": \"$spec\"" pnpm-workspace.yaml
      fi
    done
  jq 'del(.pnpm)' package.json > package.json.tmp && mv package.json.tmp package.json
fi

if git diff --quiet; then
  echo "No overrides to apply"
  exit 0
fi

# Commit before verifying so a failed verification can still be pushed as a pull request.
pnpm install --no-frozen-lockfile || open_attention_pr
git add -A
git commit --no-verify -m "chore(deps): apply socket optimize overrides"
pnpm exec turbo run check --filter='!./solidity/*' || open_attention_pr
pnpm exec turbo run test --filter='!./solidity/*' || open_attention_pr
# The pushed tree is exactly the verified one; if master moved meanwhile the push is rejected and
# the PR fallback runs.
git push "$remote" HEAD:master || open_attention_pr
