#!/bin/bash
set -euo pipefail

# Build one universal macOS .app + .dmg for Apple silicon and Intel.
# Notarizes automatically when APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID are set.
# --unsigned builds a local test artifact without release credentials.

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Linty supports macOS only." >&2
  exit 1
fi
if (( $# > 1 )) || [[ "${1:-}" != "" && "${1:-}" != --unsigned ]]; then
  echo "Usage: yarn build:mac [--unsigned]" >&2
  exit 1
fi
TARGET_DIR="${CARGO_TARGET_DIR:-src-tauri/target}/universal-apple-darwin/release"
DMG_DIR="$TARGET_DIR/bundle/dmg"
APP_DIR="$TARGET_DIR/bundle/macos"
BUILD_ARGS=(--target universal-apple-darwin --bundles dmg,app --features local-stt,parakeet)
if [[ "${1:-}" == --unsigned ]]; then
  unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  BUILD_ARGS+=(--no-sign --config '{"bundle":{"createUpdaterArtifacts":false}}')
else
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Hari Shekhar (3RPKRQ84N3)}"
fi

# Build (Tauri notarizes .app automatically if env vars are set)
tauri build "${BUILD_ARGS[@]}"
xcrun lipo "$APP_DIR/Linty.app/Contents/MacOS/linty" -verify_arch arm64 x86_64

shopt -s nullglob
DMGS=("$DMG_DIR"/*.dmg)
if (( ${#DMGS[@]} != 1 )); then
  echo "Expected exactly one DMG in $DMG_DIR; remove stale installers before building." >&2
  exit 1
fi
DMG_PATH="${DMGS[0]}"
VERSION="$(node -p 'require("./package.json").version')"

# Copy DMG to release/
mkdir -p release
cp -f "$DMG_PATH" release/linty.dmg
cp -f "$DMG_PATH" "release/linty-$VERSION.dmg"

# Strip provenance attrs so local .app works without notarization
xattr -cr "$APP_DIR/Linty.app"

# Notarize DMG if credentials are available
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "Notarizing DMG: $DMG_PATH"

  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  xcrun stapler staple "$DMG_PATH"

  # Update release copy with stapled DMG
  cp -f "$DMG_PATH" release/linty.dmg
  cp -f "$DMG_PATH" "release/linty-$VERSION.dmg"

  echo "DMG notarized and stapled."
else
  echo "Skipping DMG notarization (no APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID)."
fi
