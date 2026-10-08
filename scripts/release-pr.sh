#!/usr/bin/env bash
# Opens or updates the release PR from pending changesets, from the RWX release-pr task. Merging the
# PR runs publish-prod. GITHUB_TOKEN is the PAT, so the PR is a real user PR that receives checks.

set -euo pipefail

branch=changeset-release/master
title="chore: release packages"

if ! compgen -G '.changeset/*.md' > /dev/null; then
  echo "No pending changesets"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -B "$branch"
pnpm run packages:version
git add -A
git commit --no-verify -m "$title"
git push --force "https://x-access-token:${GITHUB_TOKEN}@github.com/tunnckoCoreHQ/monarch.git" "HEAD:refs/heads/$branch"

body=$(mktemp)
trap 'rm -f "$body"' EXIT
printf 'Merging this PR publishes the packages below with latest.\n\n# Releases\n' > "$body"
for manifest in $(git diff --name-only HEAD~1 -- '*/*/package.json'); do
  name=$(jq -r .name "$manifest")
  version=$(jq -r .version "$manifest")
  [ "$(git show "HEAD~1:$manifest" | jq -r .version)" != "$version" ] || continue
  printf '\n## %s@%s\n' "$name" "$version" >> "$body"
  # The changelog entry is everything between this version's heading and the next one.
  awk -v heading="## $version" '$0 == heading { found = 1; next } found && /^## / { exit } found' \
    "$(dirname "$manifest")/CHANGELOG.md" >> "$body"
done

pr=$(gh pr list --repo tunnckoCoreHQ/monarch --head "$branch" --base master --state open --json number --jq '.[0].number // empty')
if [ -n "$pr" ]; then
  gh pr edit "$pr" --repo tunnckoCoreHQ/monarch --title "$title" --body-file "$body"
else
  gh pr create --repo tunnckoCoreHQ/monarch --head "$branch" --base master --title "$title" --body-file "$body"
fi
