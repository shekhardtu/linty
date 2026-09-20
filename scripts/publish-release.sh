#!/usr/bin/env bash
set -euo pipefail

# The workflow creates a draft first. Retry each upload independently so a
# network failure does not discard successful assets or require another build.
tag="${1:?Usage: scripts/publish-release.sh TAG}"
shopt -s nullglob
bundle_dir="${LINTY_BUNDLE_DIR:-src-tauri/target/release/bundle}"
dmgs=("$bundle_dir"/dmg/*.dmg)
archives=("$bundle_dir"/macos/*.app.tar.gz)
signatures=("$bundle_dir"/macos/*.app.tar.gz.sig)
if (( ${#dmgs[@]} == 0 || ${#archives[@]} == 0 || ${#signatures[@]} == 0 )); then
  echo "::error::Release bundles or updater signatures are missing."
  exit 1
fi
assets=("${dmgs[@]}" "${archives[@]}" "${signatures[@]}" latest.json)
for asset in "${assets[@]}"; do
  if [[ ! -s "$asset" ]]; then
    echo "::error::Release asset is missing or empty: $asset"
    exit 1
  fi
done

retry() {
  local description="$1"
  shift
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    if (( attempt < 3 )); then
      echo "::warning::$description failed (attempt $attempt/3); retrying in $((attempt * 5))s"
      sleep "$((attempt * 5))"
    fi
  done
  echo "::error::$description failed after 3 attempts."
  return 1
}

require_draft() {
  local draft
  draft=$(gh release view "$tag" --json isDraft --jq '.isDraft') || return 1
  if [[ "$draft" != true ]]; then
    echo "::error::Refusing to replace assets on published release $tag."
    return 1
  fi
}

retry "Check draft release $tag" require_draft
for asset in "${assets[@]}"; do
  retry "Upload $(basename "$asset")" gh release upload "$tag" "$asset" --clobber
done
# Publish only after every upload succeeds. Retrying this operation is safe if
# GitHub published the release but the response was lost.
retry "Publish release $tag" gh release edit "$tag" --draft=false
