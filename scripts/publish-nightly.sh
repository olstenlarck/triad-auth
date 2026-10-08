#!/usr/bin/env bash
# Publishes nightly versions of the packages the pushed commit changed, for one registry. The vlt
# argument takes the @tunnckocore packages, which go to npm.wgw.lol with the nightly environment's OIDC
# token; the Worker allows it to write only the nightly dist-tag. The npm argument takes the
# unscoped packages, which go to npmjs.com with NPM_TOKEN. Each share builds and publishes only
# its own packages. Pending changesets for other packages stay untouched for their stable
# release. master takes squash merges, so the pushed commit's parent is the previous master.
# Usage: bash scripts/publish-nightly.sh <vlt|npm>

set -euo pipefail

case "${1:-}" in
  vlt) scoped=true ;;
  npm) scoped=false ;;
  *)
    echo "Usage: bash scripts/publish-nightly.sh <vlt|npm>" >&2
    exit 1
    ;;
esac

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
  if [[ $name == @tunnckocore/* ]]; then [ "$scoped" = true ] || continue; else [ "$scoped" = false ] || continue; fi
  grep -qxF "$name" <<< "$changed" || continue
  filters+=(--filter "$name")
  published+=("$name@$(jq -r .version "$manifest")")
done
if [ "${#published[@]}" -eq 0 ]; then
  echo "Not published: this push changed no $1 package with a pending changeset"
  exit 0
fi
pnpm exec turbo run build "${filters[@]}"
# The vlt share needs no auth here: pnpm takes the GitHub OIDC token of the job to npm.wgw.lol.
[ "$scoped" = true ] || echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >> "$HOME/.npmrc"
pnpm publish -r "${filters[@]}" --tag nightly --no-git-checks
printf 'Published %s with nightly\n' "${published[@]}"
