#!/usr/bin/env bash
# Publishes nightly versions of the packages the pushed commit changed, from the RWX publish-nightly
# task. The @tunnckocore packages go to npm.wgw.lol with the nightly vault's OIDC token, which the
# Worker allows to write only the nightly dist-tag. The unscoped packages go to npmjs.com with
# NPM_TOKEN. Pending changesets for other packages stay untouched for their stable release.
# master takes squash merges, so the pushed commit's parent is the previous master.

set -euo pipefail

# Changed workspace packages and their dependents, read before snapshot versioning edits manifests.
changed=$(pnpm ls --filter "...[HEAD~1]" --json --depth -1 | jq -r '.[].name')
if ! compgen -G '.changeset/*.md' > /dev/null; then
  echo "Not published: no pending changesets"
  exit 0
fi
pnpm exec changeset version --snapshot nightly
filters=()
published=()
for manifest in $(git diff --name-only -- 'packages/*/package.json'); do
  name=$(jq -r .name "$manifest")
  grep -qxF "$name" <<< "$changed" || continue
  filters+=(--filter "$name")
  published+=("$name@$(jq -r .version "$manifest")")
done
if [ "${#published[@]}" -eq 0 ]; then
  echo "Not published: this push changed no package with a pending changeset"
  exit 0
fi
pnpm exec turbo run build "${filters[@]}"
# Read the OIDC token file last: RWX refreshes it, and npm.wgw.lol rejects tokens older than 10m.
cat >> "$HOME/.npmrc" <<EOF
//npm.wgw.lol/:_authToken=$(cat "$VLT_TOKEN_FILE")
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF
pnpm publish -r "${filters[@]}" --tag nightly --no-git-checks
printf 'Published %s with nightly\n' "${published[@]}"
