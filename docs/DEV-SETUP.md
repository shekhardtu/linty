# Linty development setup

Privacy first: use synthetic dictation data while developing and keep credentials out of the repository.

## Prerequisites

| Requirement | Supported development setup |
|---|---|
| OS / hardware | macOS 14+, Apple Silicon |
| Xcode | Full Xcode 16+ with Swift 6; select its command-line tools |
| Rust | Stable |
| Node.js | 24+ (also runs the TypeScript-stripping test runner) |
| Yarn | 1.x |

Verify your toolchain with `xcode-select -p`, `swift --version`, `rustc --version`, and `node --version`. Command Line Tools alone are not enough for the Parakeet bridge.

```bash
git clone https://github.com/shekhardtu/linty.git
cd linty
yarn install --frozen-lockfile
yarn tauri dev --features local-stt,parakeet
```

The first build fetches Swift dependencies and compiles both engines. Vite runs on port 1420 and reloads frontend edits automatically. `yarn dev` starts only the frontend; native IPC needs the Tauri app.

## Feature flags and checks

| Feature | Purpose |
|---|---|
| `local-stt` | Whisper through whisper-rs, with Metal acceleration |
| `parakeet` | Parakeet through the Swift / FluidAudio bridge; also enables `local-stt` |
| `custom-protocol` | Tauri production asset protocol |

Official macOS releases enable `local-stt,parakeet`. A development build without those features does not include the local engines.

```bash
yarn test
yarn build
cd src-tauri
cargo fmt --check
cargo check --features local-stt,parakeet
cargo test --lib --features local-stt,parakeet
```

`yarn test:ui`, `yarn test:motion`, `yarn test:usability`, and `yarn test:recovery` provide browser checks; see each script for its server and browser requirements.

## Local packaging without release credentials

Development mode does not need the maintainer's signing identity. To package an ad-hoc signed app for your own Mac, override the production signing identity and updater-artifact generation:

```bash
yarn tauri build --features local-stt,parakeet --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}'
```

This is a local test build, not a notarized public release. For permission, recording, and paste changes, test the packaged app from Finder as well as development mode; macOS TCC behavior can differ.

## Signed releases

Use the `deploy` skill or `yarn release:local --publish` from clean local `main` for an official release. The command synchronizes and pushes main, builds in an isolated worktree, validates locally, signs/notarizes, and publishes directly to GitHub Releases. See [local releases](runbooks/local-releases.md) for prerequisites and retry instructions. `scripts/build-mac.sh` remains a packaging helper; official publication requires the local release command's mandatory validation and notarization. Supply secrets through your local secure environment; no particular dotfile is required by the project.

Required release environment variables are `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The Developer ID Application certificate and private key must be available to codesign through Keychain. Never commit these values or certificate exports.

The [Build macOS DMG workflow](../.github/workflows/build-dmg.yml) is currently disabled in GitHub. It can be re-enabled with `gh workflow enable build-dmg.yml --repo shekhardtu/linty`; when enabled it runs on pushes to `main` or manual dispatch. It bumps the patch version, builds both local engines, signs and notarizes, and publishes the installer, signed updater archive, and `latest.json`. `[skip ci]` skips the push-triggered build. PR checks remain enabled independently of release publishing.

Configure these as **repository-level Actions secrets**, so release configuration stays attached to the repository if ownership changes:

| Secret | Purpose |
|---|---|
| `LINTY_APPLE_SIGNING_CERTIFICATE` | Base64-encoded Developer ID `.p12` |
| `LINTY_APPLE_SIGNING_CERTIFICATE_PASSWORD` | `.p12` export password |
| `LINTY_APPLE_NOTARIZATION_APPLE_ID` | Apple ID |
| `LINTY_APPLE_NOTARIZATION_PASSWORD` | Apple app-specific password |
| `LINTY_APPLE_TEAM_ID` | Apple Developer Team ID |
| `LINTY_TAURI_SIGNING_PRIVATE_KEY` | Existing updater signing key |
| `LINTY_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password |

Keep the app identifier and updater signing identity stable across repository moves. The release workflow derives download URLs from `GITHUB_REPOSITORY`. Previous repository release links redirect to `shekhardtu/linty`; do not recreate the old repository namespace, which would remove those redirects.

## Architecture and operational notes

- React and Zustand manage the UI; Rust handles audio, transcription, storage, and macOS integration through Tauri.
- The [native dictation pipeline](DICTATION-PIPELINE.md) owns capture, preservation checks, archive writes and one delivery attempt per session.
- `src-tauri/swift/` provides the Parakeet bridge; Whisper uses whisper-rs.
- Microphone access captures speech. Accessibility access supports key monitoring and paste. Use System Check to diagnose missing permissions.
- Do not set `LSUIElement=true` in Info.plist: it can interfere with permission prompts. Hardened Runtime uses `com.apple.security.device.audio-input`.
- Recording has no fixed duration cutoff. Audio accumulates in memory until stopped, so capacity depends on hardware and workload. See [measured capacity](TRANSCRIPTION-CAPACITY.md).
- API credentials live in [Keychain](CREDENTIAL-STORAGE.md); saved text uses [local history storage](HISTORY-STORAGE.md).
- See the [force-update runbook](runbooks/force-update.md) before changing a minimum supported version.
