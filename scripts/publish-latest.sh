#!/usr/bin/env bash
# Publishes the stable versions one registry is missing, with latest and package tags. The vlt
# argument takes the @tunnckocore packages, which go to npm.wgw.lol from Depot CI. The npm argument
# takes the unscoped packages, which go to npmjs.com from GitHub Actions. Each CI can authenticate
# only to its own registry, so each publishes only its share of the Changesets publish plan.
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
# Writes the CHANGESETS_OUTPUT events that changesets/action turns into pushed tags and GitHub Releases.
pnpm exec changeset publish --from-pack-dir "$out/pack"
