#!/usr/bin/env bash
# Publishes the stable versions the registries are missing, with latest, from the RWX publish-prod
# task. The @tunnckocore packages go to npm.wgw.lol with the prod vault's OIDC token, which the
# Worker allows to write latest. The unscoped packages go to npmjs.com with NPM_TOKEN. Then it
# pushes the new package tags and creates a GitHub Release for each, with its changelog entry.

set -euo pipefail

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
pnpm exec turbo run build --filter='./packages/*'
pnpm exec changeset publish-plan --output "$out/plan.json"
pnpm exec changeset pack --from-publish-plan "$out/plan.json" --out-dir "$out/pack"
# Read the OIDC token file last: RWX refreshes it, and npm.wgw.lol rejects tokens older than 10m.
cat >> "$HOME/.npmrc" <<EOF
//npm.wgw.lol/:_authToken=$(cat "$VLT_TOKEN_FILE")
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF
# changeset publish creates the local tags and reports each one as a git-tag event.
CHANGESETS_OUTPUT="$out/events.jsonl" pnpm exec changeset publish --from-pack-dir "$out/pack"

tags=$(jq -r 'select(.type == "git-tag") | "\(.tag)\t\(.packageName)"' "$out/events.jsonl" 2> /dev/null || true)
if [ -z "$tags" ]; then
  echo "No new package tags"
  exit 0
fi
git push "https://x-access-token:${GITHUB_TOKEN}@github.com/tunnckoCoreHQ/monarch.git" $(cut -f1 <<< "$tags")
while IFS=$'\t' read -r tag name; do
  dir=$(pnpm ls --filter "$name" --json --depth -1 | jq -r '.[0].path')
  version=${tag##*@}
  # The changelog entry is everything between this version's heading and the next one.
  awk -v heading="## $version" '$0 == heading { found = 1; next } found && /^## / { exit } found' \
    "$dir/CHANGELOG.md" > "$out/notes.md"
  gh release create "$tag" --repo tunnckoCoreHQ/monarch --title "$tag" --notes-file "$out/notes.md"
done <<< "$tags"
