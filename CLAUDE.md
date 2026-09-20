## Project Overview

Linty is a macOS voice-to-text desktop app built with Tauri v2 + React 19 + Rust. Hold the fn key to record, release to transcribe (local Whisper or Parakeet, selected automatically from the dictation language), and auto-paste the result.

## Commands

```bash
yarn dev              # Start Vite dev server (HMR on port 1420) — don't restart, changes auto-reload
yarn build            # TypeScript check + Vite production build
yarn tauri dev        # Run Tauri app in dev mode (frontend + Rust backend)
yarn build:mac        # Full release build: sign + notarize .app + .dmg (requires source ~/.tokens first)

# Rust only
cd src-tauri
cargo check --features local-stt            # Type check Rust code (Whisper only, no Swift needed)
cargo check --features local-stt,parakeet   # + Parakeet bridge (compiles swift/ via SwiftPM, slow first time)
cargo build --features local-stt,parakeet   # Build Rust backend as shipped

# Engine benchmark (uses the app's real transcription code paths)
cargo run --release --example stt_bench --features local-stt,parakeet -- clip.wav
```

Release builds (`build:mac`, CI) use `--features local-stt,parakeet`.

`scripts/check-rust-logging.sh` fails on `println!`/`eprintln!`/`dbg!` in `src-tauri/src` (runs on every PR via `.github/workflows/checks.yml`).

`node scripts/force-update.mjs --show` prints which versions must update (see `docs/runbooks/force-update.md`).

Tauri CLI bundle syntax: `--bundles dmg,app` (comma-separated, NOT space-separated).

## Architecture

### Core Flow
1. Fn key press → `fnkey.rs` emits `fnkey-pressed` event → frontend starts recording
2. Audio thread (cpal) captures to shared `Arc<Mutex<Vec<f32>>>` buffer
3. Fn key release → `stop_recording` moves samples via `std::mem::take` (zero-copy, no IPC)
4. `transcribe_buffer` reads samples directly from Rust state → returns text
5. Clipboard snapshot → write text → simulate Cmd+V paste → auto-restore clipboard

### Key Design Decisions
- **Zero-copy audio**: Samples never cross IPC — stay in Rust, transcribed in-place
- **macOS FFI over plugins**: Permissions, fn key, clipboard use raw ObjC FFI for reliability
- **Two windows**: Main app + capsule overlay (NSPanel, always-on-top, separate Z-order)
- **Feature-gated STT**: `local-stt` Cargo feature enables whisper-rs with Metal GPU; `parakeet` (implies `local-stt`) adds NVIDIA Parakeet TDT v3 on the Neural Engine through a Swift bridge (`src-tauri/swift/`, built by `build.rs`, wraps FluidAudio 0.14.8). Only one local engine is resident at a time; `transcribe_buffer` dispatches on the selected model id (`parakeet-tdt-0.6b-v3` = Parakeet bundle dir, anything else = whisper .bin). Parakeet needs macOS 14+ and Apple Silicon, has no vocabulary prompt, and its bundle is a directory FluidAudio downloads into the models dir. The Settings language list (`src/lib/languages.util.ts`) includes all 100 Whisper languages and Auto-detect. Language selection automatically prepares Parakeet for its 25 supported languages, or Whisper Turbo Q5 for other languages and Auto-detect; builds without Parakeet use Whisper. Onboarding uses the same policy. There is no manual engine picker or translate-to-English option.
- **Activation policy**: Programmatic `set_activation_policy_accessory/regular()` for tray behavior (NOT `LSUIElement` in Info.plist)

### Corrections & personal dictionary
- Editing a transcript in History diffs the pasted text against the edit (`src/lib/correction-diff.util.ts`), stores a `CorrectionRecord` (`linty-corrections.json`) and feeds word swaps into suggestions (`src/lib/dictionary.util.ts`, `linty-dictionary.json`). Suggestions become dictionary entries when accepted on the Dictionary page, or automatically when "Learn new words automatically" is on (off by default).
- Dictionary entries are applied in `useTranscription.hook.ts` before paste (whole-word, case-matching; counted as `timesApplied`, shown as "Corrected"; engine-side fixes returned in `Transcription.vocabulary_applied` count as `timesRecognized`, shown as "Recognised") and the most-used entries seed the Whisper vocabulary prompt. Parakeet has no prompt: the same entries go to `transcribe_buffer` as `vocabulary` terms and FluidAudio's CTC keyword spotter rescores the transcript (`linty_parakeet_transcribe_vocab`); `src-tauri/src/vocabulary.rs` applies only candidates that resemble the term or one of its known wrong spellings (similarity ≥ 0.6), because the rescorer over-applies. The CTC bundle (`parakeet-ctc-110m-coreml`, ~100 MB) is fetched by `prepare_parakeet_vocabulary` (called by `useParakeetVocabulary.hook.ts` once the dictionary has words) and loaded with the engine on later loads. "Apply my dictionary" (Settings → Privacy & storage) turns all of this off. `reset_all_data` deletes both JSON stores.
- Rewrites (more than 40 % of words changed) are recorded for the corrections-per-100-words metric but never learned from.
- "Learn from corrections in other apps" (off by default) uses verified Accessibility capture and a two-minute session that can retain several pasted spans. It emits batches through `correction-observed`; only reusable, classified spelling corrections can become dictionary entries. See `docs/CORRECTION-CAPTURE-IMPLEMENTATION.md` for supported editors and session boundaries.

### Logging (local only)
- The backend logs through the `log` crate. `src-tauri/src/logging.rs` registers `tauri-plugin-log` and writes `~/Library/Logs/ai.linty.desktop/linty.log` (rotated at 5 MB, five files kept) plus stderr. Debug level in dev builds, info in release. Nothing is uploaded.
- **Redaction rule:** never log transcript text, clipboard contents, API keys or dictionary words. Log counts, lengths (`chars().count()`), durations, engine and model names. Check error strings too: serde_json errors, for example, quote the value they failed on. The log formatter replaces the home folder with `~` in every line.
- Messages keep a `[subsystem]` prefix (`[stt]`, `[paste]`, `[fnkey]`, ...). Per-dictation summaries are `info`; per-event detail is `debug`.
- A panic hook logs the message and backtrace, then writes `crash.marker` (time, version, thread, location) to the app data dir. The next launch logs a warning while the marker exists; `reset_all_data` deletes it. Native crashes still go to `~/Library/Logs/DiagnosticReports`.
- Startup removes the legacy `~/linty-fnkey.log` that older builds wrote.

### Updates and force update
- `useUpdater.hook.ts` checks GitHub's latest release 5 s after launch, every 15 minutes and on `system-wake`. There is no update server.
- A release's `latest.json` may carry `minimum_version`. When the running version is below it and the offered release meets it (`src/lib/force-update.util.ts`), `UpdateRequired.dialogue.tsx` blocks the window, the update downloads at once, and it installs after 30 s without dictation (`waitUntilIdle`). The release is checked again just before installing, then the app relaunches.
- `node scripts/force-update.mjs` sets or clears the minimum on the latest release with `gh`. The build workflow carries the previous minimum into each new release and has a manual `force_update` input. Operations: `docs/runbooks/force-update.md`.
- The field is unsigned on purpose: it can only require the newest release, which the updater verifies with the release key. There is no downgrade; bad releases are fixed forward.

### State Management
- **Frontend**: Zustand store split into slices (recording, transcription, settings, navigation, history, toast)
- **Backend**: `AppState` struct managed by Tauri — `Arc<Mutex<>>` for audio buffer, whisper context, recording state
- **Persistence**: `tauri-plugin-store` saves settings and dictionary data to JSON. Transcript history and opt-in audio use SQLite in the app data directory (see docs/HISTORY-STORAGE.md).

## macOS Entitlements & TCC

Linty uses **Hardened Runtime** (not App Sandbox). Critical distinction:

| Permission | Hardened Runtime (correct) | App Sandbox (wrong) |
|---|---|---|
| Microphone | `com.apple.security.device.audio-input` | `com.apple.security.device.microphone` |

**Wrong entitlement key = macOS TCC silently denies without ever showing a prompt.**

- Do NOT set `LSUIElement=true` in Info.plist — prevents TCC prompts on macOS Sequoia
- Terminal launch (`./Linty.app/Contents/MacOS/linty`) bypasses entitlement checks — always test TCC from Finder/DMG install
- `tccutil reset Microphone ai.linty.desktop` clears stale TCC entries after entitlement changes
- Once denied, `requestAccessForMediaType:` returns false without prompting — guide user to System Settings

## Build & Notarization

- Tauri auto-notarizes `.app` when `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` env vars are set
- `.dmg` must be notarized separately (`xcrun notarytool submit` + `xcrun stapler staple`)
- Both handled by `scripts/build-mac.sh` and CI workflow (`.github/workflows/build-dmg.yml`)
- CI runs required checks before release builds. It creates a version commit and immutable release tag without pushing around main branch protection, then builds, notarizes, and publishes. Versions advance past existing release tags.
