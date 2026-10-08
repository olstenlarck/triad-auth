#!/usr/bin/env bash
# Publishes the stable versions one registry is missing, with latest and package tags, then pushes
# the new tags and creates a GitHub Release for each, with its changelog entry. The vlt argument
# takes the @tunnckocore packages, which go to npm.wgw.lol with the prod vault's OIDC token. The
# npm argument takes the unscoped packages, which go to npmjs.com with NPM_TOKEN. Each share
# builds and publishes only its own packages, so either one can move to another CI on its own.
# Usage: pnpm run packages:publish <vlt|npm>

set -euo pipefail

case "${1:-}" in
  vlt)
    share='startswith("@tunnckocore/")'
    builds=(--filter='@tunnckocore/*')
    ;;
  npm)
    share='startswith("@tunnckocore/") | not'
    builds=(--filter='./packages/*' --filter='!@tunnckocore/*')
    ;;
  *)
    echo "Usage: pnpm run packages:publish <vlt|npm>" >&2
    exit 1
    ;;
esac

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
pnpm exec turbo run build "${builds[@]}"
pnpm exec changeset publish-plan --output "$out/plan.json"
jq ".plan |= (map(map(select(.name | $share))) | map(select(length > 0)))" "$out/plan.json" > "$out/share.json"
pnpm exec changeset pack --from-publish-plan "$out/share.json" --out-dir "$out/pack"
# The vlt share needs no auth here: pnpm exchanges NPM_ID_TOKEN at npm.wgw.lol, as it did on Depot.
[ "$1" = vlt ] || echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >> "$HOME/.npmrc"
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
