---
name: rca
user-invocable: true
disable-model-invocation: false
description: Root Cause Analysis for desktop app issues. Investigates audio capture failures, transcription errors, permission denials, clipboard/paste failures, capsule overlay issues, fn key detection, build/release problems, performance issues, and crashes. Triggers on "investigate issue", "root cause", "debug issue", "why is this broken", "not recording", "blank transcription", "permission denied", "paste not working", "capsule not showing", "fn key not working", "crash", "panic".
---

# RCA — Root Cause Analysis

Systematic investigation of Linty desktop app issues using macOS system tools, Rust/Tauri diagnostics, and the local codebase. Use this when a user reports a problem — recording not working, blank transcription, permission denied, paste failure, capsule overlay missing, fn key not detected, crash, performance issue, etc.

## Core Concept: Event Trace

The investigation traces events across the desktop app stack to reconstruct the full lifecycle of a user action:

```
 macOS System          Rust Backend (Tauri)         React Frontend
     |                      |                            |
     | fn key press         |                            |
     | (NSEvent monitor)    |                            |
     +--- fnkey.rs ---------+--- fnkey-pressed event --->|
     |                      |                            | Zustand: recording=true
     |                      |                            |
     | cpal audio device    |                            |
     +--- audio.rs -------->| Arc<Mutex<Vec<f32>>>       |
     |    (16kHz mono)      | buffer grows               |
     |                      |                            |
     | fn key release       |                            |
     +--- fnkey.rs ---------+--- fnkey-released event -->|
     |                      |                            | calls stop_recording
     |                      | std::mem::take (zero-copy) |
     |                      |                            |
     |                      | transcribe_buffer          |
     |                      | (whisper-rs / Groq API)    |
     |                      +--- transcription result -->|
     |                      |                            | Zustand: text update
     | NSPasteboard         |                            |
     +--- clipboard.rs ---->| snapshot → write → Cmd+V   |
     |    (snapshot/restore) | → restore                 |
     |                      |                            |
     | NSPanel              |                            |
     +--- capsule.rs ------>| overlay panel state        |
```

**How it flows:**
1. macOS NSEvent monitor detects fn key press in `fnkey.rs`
2. Tauri event emitted to frontend, Zustand starts recording state
3. cpal audio thread captures to shared buffer in `audio.rs`
4. Fn key release stops recording, `std::mem::take` moves samples (zero-copy)
5. `transcribe_buffer` runs whisper-rs (local Metal GPU) or Groq cloud API
6. Clipboard snapshot, write text, simulate Cmd+V paste, restore clipboard
7. Capsule overlay (NSPanel) shows state throughout the flow

## Input Required

Ask the user for (if not already provided):
1. **What happened** — what they saw or expected vs actual behavior
2. **When** — just now, intermittent, after update, after system restart
3. **What they were doing** — recording, transcribing, which app was focused
4. **macOS version** — especially relevant for TCC permission issues
5. **Screenshot/error** — if available, analyze to narrow investigation
6. **STT mode** — local (whisper-rs) or cloud (Groq)

## Investigation Workflow

Execute steps IN ORDER. Run independent queries in PARALLEL where possible.

---

### Step 1: Categorize the Issue

Based on user report, classify into one of the issue categories below. This determines which investigation steps to prioritize.

| Category | Description | Example |
|----------|-------------|---------|
| **Audio Capture Failure** | Recording doesn't capture or captures silence | cpal device issue, wrong sample rate, buffer not growing |
| **Transcription Error** | Blank/wrong/hallucinated text | Silence guard too aggressive, model not loaded, Groq API error |
| **Permission Denied** | macOS TCC blocks mic or accessibility | Wrong entitlement, LSUIElement, stale TCC cache |
| **Clipboard/Paste Failure** | Text not pasted or wrong clipboard state | Accessibility denied, CGEvent timing, clipboard restore race |
| **Capsule Overlay Issue** | Floating panel not visible or mispositioned | NSPanel not initialized, z-order, system wake |
| **Fn Key Not Working** | Key press not detected | Accessibility permission, NSEvent monitor died, wake recovery |
| **Build/Release Issue** | App doesn't build, notarization fails | Missing features flag, signing issues, CI workflow |
| **Performance Issue** | Slow transcription, high CPU/memory | Metal GPU cold start, runaway recording, watchdog not triggered |
| **Crash/Panic** | App crashes during recording or transcription | Rust panic, unwrap failure, FFI crash |

---

### Step 2: Check macOS Permissions

TCC (Transparency, Consent, and Control) is the most common source of silent failures on macOS.

```bash
# Check microphone TCC status for Linty
# Note: TCC database is protected; use tccutil for resets
tccutil reset Microphone ai.linty.desktop

# Check if accessibility permission is granted (needed for fn key + paste)
# Look in System Settings > Privacy & Security > Accessibility

# Check entitlements on the built app
codesign -d --entitlements - /Applications/Linty.app 2>&1
```

**Key entitlement checks:**
- Microphone: must be `com.apple.security.device.audio-input` (NOT `.microphone`)
- Hardened Runtime: NOT App Sandbox
- `LSUIElement` must NOT be `true` in Info.plist (prevents TCC prompts on Sequoia)

**Check source entitlements:**
```bash
# Read the entitlements file
cat /Users/hari/2025/mp/linty/src-tauri/Entitlements.plist

# Read Info.plist for LSUIElement
cat /Users/hari/2025/mp/linty/src-tauri/Info.plist
```

**Important TCC notes:**
- Terminal launch (`./Linty.app/Contents/MacOS/linty`) bypasses entitlement checks — always test from Finder/DMG
- Once denied, `requestAccessForMediaType:` returns false without prompting — guide user to System Settings
- After entitlement changes, reset TCC: `tccutil reset Microphone ai.linty.desktop`

---

### Step 3: Check Audio Device & Capture

If the issue involves recording or silence:

```bash
# List available audio input devices
system_profiler SPAudioDataType
```

**Check the Rust audio code:**
- Read `src-tauri/src/audio.rs` — verify cpal device selection, sample rate (16kHz), channel config (mono)
- Check if `Arc<Mutex<Vec<f32>>>` buffer is growing during recording
- Look for error handling on device enumeration failures
- Verify `std::mem::take` correctly moves samples on stop

**Common audio issues:**
- No default input device available
- Sample rate mismatch (cpal default vs whisper's expected 16kHz)
- Buffer mutex lock contention or deadlock
- cpal stream callback errors (device disconnected mid-recording)

---

### Step 4: Check Rust Backend State

Investigate `AppState` and the Tauri command handlers:

```bash
# Check Rust code compiles
cd /Users/hari/2025/mp/linty/src-tauri && cargo check --features local-stt
```

**Key state to verify in code:**
- `AppState` struct fields: recording flag, audio buffer, whisper context
- `start_recording` / `stop_recording` command handlers
- `transcribe_buffer` — whisper-rs model loaded? Groq API key set?
- Watchdog timer state — is it detecting runaway recordings?

**Read key files:**
- `src-tauri/src/lib.rs` — app setup, state initialization
- `src-tauri/src/audio.rs` — cpal capture logic
- `src-tauri/src/transcribe.rs` — whisper-rs local + Groq cloud
- `src-tauri/src/fnkey.rs` — NSEvent fn key monitor
- `src-tauri/src/clipboard.rs` — NSPasteboard snapshot/restore
- `src-tauri/src/paste.rs` — Cmd+V simulation via enigo (Unicode keys do a TIS layout lookup — main-thread-only on macOS 26)
- `src-tauri/src/capsule.rs` — overlay panel
- `src-tauri/src/permissions.rs` — AVFoundation mic FFI
- `src-tauri/src/watchdog.rs` — runaway recording recovery

---

### Step 5: Check Frontend State

If the Rust backend seems correct, investigate the React frontend:

**Key frontend areas:**
- `src/store/slices/` — Zustand slices (recording, transcription, settings, navigation, history, toast)
- `src/hooks/` — recording hook, transcription hook
- `src/services/` — permissions, paste, correction services
- `src/pages/` — page components
- `src/components/` — capsule, sidebar, waveform

**Things to check:**
- Zustand store state transitions (recording start/stop, transcription lifecycle)
- Tauri event listeners (`fnkey-pressed`, `fnkey-released`) — are they registered?
- IPC command invocations — correct command names and parameters?
- Error handling in async operations (try/catch around `invoke()`)

---

### Step 6: Check Logs & Console Output

```bash
# Run app in dev mode to see all output
yarn tauri dev

# Check macOS system log for crash reports
log show --predicate 'process == "linty"' --last 5m

# Check for crash reports
ls ~/Library/Logs/DiagnosticReports/ | grep -i linty
```

**Rust stderr/stdout:**
- Rust logs go to `~/Library/Logs/ai.linty.desktop/linty.log` (rotated `linty_<date>.log` files alongside) and to the `yarn tauri dev` terminal
- `~/Library/Application Support/ai.linty.desktop/crash.marker` exists after a Rust panic; the matching backtrace is in the log
- Look for panic messages, unwrap failures, FFI errors
- Check whisper-rs model loading messages (Metal GPU init)

---

### Step 7: Check Recent Code Changes

```bash
# Recent commits
git -C /Users/hari/2025/mp/linty log --oneline -20

# Changes in specific area
git -C /Users/hari/2025/mp/linty log --oneline --since="3 days ago" -- "src-tauri/src/"
git -C /Users/hari/2025/mp/linty log --oneline --since="3 days ago" -- "src/"

# Check recent PRs
gh pr list --repo shekhardtu/linty --state merged --limit 10

# Diff a specific PR
gh pr diff <pr_number> --repo shekhardtu/linty
```

---

### Step 8: Check Build & System State

```bash
# Frontend build
cd /Users/hari/2025/mp/linty && yarn build

# Rust build
cd /Users/hari/2025/mp/linty/src-tauri && cargo check --features local-stt

# Check Metal GPU support
system_profiler SPDisplaysDataType | grep -i metal

# Check macOS version
sw_vers

# Check available microphone devices
system_profiler SPAudioDataType
```

---

### Step 9: Finalize RCA Report

**Present summary to user:**

| Section | Content |
|---------|---------|
| **Issue** | What the user reported |
| **Category** | One of the 9 categories above |
| **Root cause** | Clear explanation of WHY the issue occurred |
| **Evidence** | Log output, code paths, system state that confirms the cause |
| **Recommendation** | Fix, workaround, or configuration change |
| **Affected files** | List of source files involved |

**Create GitHub issue (if bug found):**

```bash
gh issue create --repo shekhardtu/linty --title "[RCA] <short description>" --body "$(cat <<'EOF'
## Root Cause Analysis

**Category:** <category>
**Root cause:** <explanation>

## Evidence
<logs, code paths, system state>

## Recommendation
<fix or workaround>

## Affected Files
- `<file paths>`
EOF
)"
```

## Key Reference

### Tools & What They Provide

| Tool | Use For |
|------|---------|
| **macOS system tools** | `tccutil` (TCC reset), `codesign` (entitlements), `log show` (system logs), `system_profiler` (hardware), `sw_vers` (OS version), `ioreg` (device tree) |
| **Cargo/Rust** | `cargo check`, `cargo build`, compile errors, Rust diagnostics |
| **Yarn/Vite** | `yarn build`, `yarn tauri dev`, frontend build errors |
| **GitHub CLI** | `gh pr list`, `gh pr diff`, `gh issue create`, commit history |
| **Git** | `git log`, `git diff`, `git blame`, code change history |
| **File reading** | Direct inspection of Rust, TypeScript, config files |

### Infrastructure Reference

| Resource | Value |
|----------|-------|
| **Platform** | macOS desktop (Hardened Runtime, NOT App Sandbox) |
| **Bundle ID** | `ai.linty.desktop` |
| **Framework** | Tauri v2 (Rust backend + React frontend) |
| **Frontend** | React 19 + Zustand + Vite + TypeScript |
| **Backend** | Rust + Tauri 2 + cpal + whisper-rs |
| **Local STT** | whisper-rs with Metal GPU acceleration (feature-gated: `local-stt`) |
| **Cloud STT** | Groq API |
| **Audio** | cpal library, 16kHz mono, shared `Arc<Mutex<Vec<f32>>>` buffer |
| **macOS FFI** | ObjC FFI for NSEvent (fn key), AVFoundation (mic), NSPasteboard (clipboard), CGEvent (paste), NSPanel (capsule) |
| **Activation** | Programmatic `set_activation_policy_accessory/regular()` (NOT `LSUIElement`) |
| **Persistence** | `tauri-plugin-store` (JSON files in app data dir) |
| **Build** | `yarn build` (frontend) + `cargo build --features local-stt` (Rust) |
| **Release** | `scripts/build-mac.sh`, CI auto-version-bump, notarization |
| **GitHub Repo** | `shekhardtu/linty` |
| **CI** | `.github/workflows/build-dmg.yml` |

### Project Structure

| Path | Purpose |
|------|---------|
| `src/` | React frontend (pages, hooks, store, services, components) |
| `src/pages/` | 6 pages |
| `src/hooks/` | Recording, transcription hooks |
| `src/store/slices/` | Zustand slices (recording, transcription, settings, navigation, history, toast) |
| `src/services/` | Permissions, paste, correction services |
| `src/components/` | Capsule, sidebar, waveform components |
| `src-tauri/` | Rust backend |
| `src-tauri/src/lib.rs` | App setup, Tauri command definitions (sync commands run on the MAIN thread — keep them light) |
| `src-tauri/src/state.rs` | AppState struct (recording, audio buffer, whisper ctx, watchdog counters) |
| `src-tauri/src/tray.rs` | Tray icon menu, engine selector, status tooltip |
| `src-tauri/src/audio.rs` | cpal audio capture (16kHz mono) |
| `src-tauri/src/transcribe.rs` | whisper-rs local + Groq cloud STT |
| `src-tauri/src/fnkey.rs` | NSEvent fn key monitor |
| `src-tauri/src/permissions.rs` | AVFoundation mic FFI |
| `src-tauri/src/clipboard.rs` | NSPasteboard snapshot/restore |
| `src-tauri/src/paste.rs` | Cmd+V simulation via enigo (`Key::Unicode` hits TIS — main-thread-only) |
| `src-tauri/src/capsule.rs` | Overlay panel (NSPanel) |
| `src-tauri/src/watchdog.rs` | Runaway recording recovery |
| `src-tauri/Entitlements.plist` | Hardened Runtime entitlements |
| `src-tauri/Info.plist` | App metadata |
| `scripts/build-mac.sh` | Build + sign + notarize script |
| `.github/workflows/build-dmg.yml` | CI build workflow |

## Tips

### Maximize Parallelism
- Steps 2, 3, 6, 7 can run in parallel — they query different systems
- Check permissions while reading audio code
- Check recent git changes while running build checks

### Permission Issues
- TCC is the #1 cause of "it works in dev but not in release" — always check
- Microphone entitlement must be `com.apple.security.device.audio-input` (Hardened Runtime)
- Accessibility permission needed for both fn key monitoring AND paste simulation
- After any entitlement change, reset TCC cache: `tccutil reset Microphone ai.linty.desktop`
- Terminal launch bypasses entitlement checks — test from Finder/DMG

### Audio Issues
- cpal device enumeration can fail silently — check for `None` default device
- Sample rate must be 16kHz for whisper-rs — verify cpal stream config
- Buffer mutex deadlock: check if lock is held across await points
- Silence detection: check threshold values in transcribe.rs

### Transcription Issues
- whisper-rs Metal GPU cold start: first transcription is slow (see `transcribe.rs` warm-up)
- Groq API: check API key in settings, network connectivity, rate limits
- Silence guard: may reject recordings with long pauses (see recent fixes)
- Model not loaded: check whisper context initialization in AppState

### Clipboard/Paste Issues
- Accessibility permission required for CGEvent paste simulation
- Race condition: clipboard restore may happen before paste completes
- Some apps intercept Cmd+V differently — check focused app
- Same speech pasted twice with DIFFERENT wording/punctuation = a second STT engine, not Linty (issue #32): Linty's NSEvent monitors are observe-only, so fn presses also reach macOS Dictation. Check `defaults read com.apple.HIToolbox AppleFnUsageType` and installed models in `defaults read com.apple.assistant.support`. Cross-reference `~/Library/Application Support/ai.linty.desktop/linty-history.json` — one record per dictation proves Linty's pipeline ran once (local whisper greedy decoding is deterministic: same audio → identical text)
- SIGTRAP in `_dispatch_assert_queue_fail` → `TSMGetInputSourceProperty` on a tokio worker = TIS layout lookup off the main thread (`paste.rs` `resolve_v_keycode`, formerly enigo `Key::Unicode`); macOS 26 asserts main-queue (issue #26)

### Capsule Overlay
- NSPanel z-order issues after system sleep/wake
- Panel may not be visible if created before window server is ready

### General
- For heat/overload/slowness reports, FIRST check whether Linty is actually the consumer: `ps -eo pid,pcpu,etime,comm | sort -rk2 | head` — users attribute system-wide symptoms to whichever app they just interacted with. Sample Linty (`sample <pid> 10`) to confirm or rule out before reading code.
- When user provides a screenshot, analyze what IS visible vs what ISN'T to narrow scope
- `yarn tauri dev` gives the richest debug output — use it for reproduction
- Check `src-tauri/Cargo.toml` for feature flags — `local-stt` gates whisper-rs

---

## Self-Healing

**After every `/rca` execution**, run this phase to keep the skill accurate and discoverable.

### Evaluate Skill Accuracy

Re-read this skill file (`Read` tool on `.claude/skills/rca/SKILL.md`) and compare its instructions against what actually happened during this execution:

| Check | What to look for |
|-------|-----------------|
| **File paths** | Did any Rust or TypeScript files move, rename, or get deleted? |
| **CLI commands** | Did `cargo check`, `yarn build`, `tccutil`, `codesign`, or `gh` commands fail or change syntax? |
| **App state** | Did `AppState` fields change? New Tauri commands added? |
| **macOS APIs** | Did any macOS FFI patterns change (NSEvent, AVFoundation, NSPasteboard, CGEvent)? |
| **Build system** | Did Cargo features, Tauri config, or build scripts change? |
| **New tools** | Were any new diagnostic tools or approaches used that aren't documented here? |

### Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Update the Infrastructure Reference or Project Structure tables if paths changed
3. Keep changes minimal and targeted
4. Log each fix:

   ```
   Self-Healing Log:
   - Fixed: <what was wrong> -> <what it was changed to>
   - Reason: <why the original was inaccurate>
   ```

If nothing needs fixing, skip silently.

### Append Trigger Documentation

After execution, display skill attribution to the user:

**Output summary:**
```
Skill: /rca
File:  .claude/skills/rca/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/rca/SKILL.md
```
