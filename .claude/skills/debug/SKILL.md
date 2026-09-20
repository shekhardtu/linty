---
name: debug
user-invocable: true
disable-model-invocation: false
description: Systematic debugging for Linty (macOS voice-to-text desktop app, Tauri v2 + React 19 + Rust). Uses Google SRE methodology to trace issues through all layers — fn key detection, audio capture, transcription (Whisper/Groq), clipboard/paste, capsule overlay, macOS permissions, frontend state, and build. Triggers on "debug this", "debug the app", "why is this failing", "trace the issue", "find the bug", "debug build", "debug error".
---

# Debug — Systematic Application Debugging

Strategic, methodical debugging modeled after [Google SRE's troubleshooting methodology](https://sre.google/sre-book/effective-troubleshooting/) and the **hypothetico-deductive method**: observe, theorize, test, confirm, fix, verify.

## Core Principle: Trace Correlation

Debug traces signals across every layer to reconstruct the full lifecycle of a voice-to-text operation:

```
User presses Fn key
    |
    v
[macOS FFI]  fnkey.rs → NSEvent monitor → emits fnkey-pressed/released event
    |
    v
[Frontend]   useRecording.hook.ts → listens for events → calls start_recording/stop_recording
    |
    v
[Audio]      audio.rs → cpal capture thread → 16kHz mono → Arc<Mutex<Vec<f32>>> buffer
    |
    v
[Transcribe] transcribe.rs → whisper-rs (local Metal GPU) or Groq API (cloud)
    |
    v
[Clipboard]  clipboard.rs → snapshot → write text → paste.rs → CGEvent Cmd+V → restore
    |
    v
[UI]         Capsule overlay (capsule.rs / CapsulePanel.component.tsx) + Dashboard / History
```

## When to Use

- Recording fails (no audio, silence, distorted sound, wrong device)
- Transcription fails (blank text, hallucinated text, wrong text, slow)
- macOS permissions broken (mic denied, accessibility denied, TCC issues)
- Fn key not working (not detected, stuck recording, double trigger)
- Paste not working (text not pasted, wrong text, clipboard corrupted)
- Capsule overlay broken (not showing, wrong position, z-order issue)
- Frontend state issues (UI wrong, stale state, component crash)
- Build failures (TypeScript errors, Rust compilation, Cargo feature issues)
- Post-sleep issues (audio stream died, fn key monitor lost, panel gone)

## When NOT to Use

- You know the exact bug already and just need to fix it — fix directly
- Code style/quality issues — fix directly or use a code quality approach

---

## Phase 1: INTAKE — Problem Report

Collect structured information before touching code.

### Required Context

| Field | Description | Example |
|-------|-------------|---------|
| **Symptom** | What the user observes | "Recording starts but transcription is blank" |
| **Expected** | What should happen | "Spoken words should appear as text and paste" |
| **Steps to reproduce** | How to trigger the issue | "Hold fn key, speak, release fn key" |
| **Scope** | Which layer is affected | Audio / Transcription / Permissions / Fn Key / Clipboard / UI / Build |
| **Recency** | When it started | "After last commit" / "After system sleep" / "Always" / "Intermittent" |

### Quick Classification

Classify the issue type to route investigation efficiently:

| Type | Signals | Start At |
|------|---------|----------|
| **Audio Issue** | No recording, silence, distorted audio, wrong device | Phase 3A (Audio) |
| **Transcription Issue** | Blank text, wrong text, hallucination, slow | Phase 3B (Transcription) |
| **macOS Permission** | Mic denied, accessibility denied, TCC issue | Phase 3C (Permissions) |
| **Fn Key Issue** | Key not detected, stuck recording, double trigger | Phase 3D (Fn Key) |
| **Clipboard/Paste** | Text not pasted, wrong text, clipboard corrupted | Phase 3E (Clipboard) |
| **Capsule Issue** | Overlay not showing, wrong position, z-order | Phase 3F (Capsule) |
| **Frontend Bug** | UI wrong, state stale, component crash | Phase 3G (Frontend) |
| **Build Failure** | TypeScript errors, Rust compilation, Cargo features | Phase 3H (Build) |
| **Unknown** | Can't classify yet | Phase 2 (full triage) |

---

## Phase 2: TRIAGE — Stabilize Before Diagnosing

**Google SRE principle**: _"Your first instinct in a major outage may be to start troubleshooting and find root cause. Ignore that instinct. Stabilize first."_

### 2.1 Check System Health (Parallel)

Run ALL of these simultaneously to establish baseline:

```bash
# 1. Rust backend compiles?
cd src-tauri && cargo check --features local-stt 2>&1 | tail -20

# 2. Frontend compiles?
yarn build 2>&1 | tail -20

# 3. App can launch?
yarn tauri dev
```

### 2.2 Establish What IS Working

**Key insight**: _"Understanding what DID work vs what DIDN'T narrows investigation scope by 80%."_

Before investigating what's broken, confirm what's healthy:
- Does the app launch at all? (Tauri window appears)
- Does the capsule overlay show? (NSPanel visible)
- Does the fn key trigger recording state change? (UI shows recording indicator)
- Is audio being captured? (buffer growing, waveform visible)
- Does transcription return text? (check Tauri console logs)
- Does paste work? (text appears in target app)
- Did this work before sleep/restart? (system wake recovery issue)

### 2.3 Check Recent Changes

**Google SRE**: _"Systems maintain inertia — they work until external forces act."_

```bash
# What changed recently?
git log --oneline -10

# What files changed in last commit?
git diff HEAD~1 --name-only

# Any uncommitted changes?
git status

# Diff of current changes
git diff
```

If the bug appeared after a specific commit, bisect to confirm:
```bash
git log --oneline -20  # Find the suspect range
# Then manually check the diff of the suspect commit
git diff <commit>~1..<commit>
```

---

## Phase 3: EXAMINE — Systematic Signal Collection

Based on the classification from Phase 1, start with the most relevant layer. Run independent checks in PARALLEL.

### 3A. Audio Layer

**File**: `src-tauri/src/audio.rs`

| Check | What to Look For |
|-------|-----------------|
| cpal stream running? | Default input device available and stream created |
| Sample rate correct? | Should be 16kHz (resampled from device native rate) |
| Channel count? | Should be mono (1 channel) |
| Buffer growing? | `Arc<Mutex<Vec<f32>>>` accumulating samples during recording |
| Audio callback count? | Watchdog checks this — if stale, stream silently failed |
| Device selection? | System default input device vs. user-configured device |
| Post-sleep recovery? | cpal audio stream may die after macOS sleep/wake cycle |

**Key state to inspect**:
- `AppState.audio_buffer` — the shared `Arc<Mutex<Vec<f32>>>` that holds raw samples
- `AppState.is_recording` — whether recording state is active
- Audio callback count — monitored by watchdog for runaway detection

**Related files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/audio.rs` | cpal audio capture, 16kHz resampling |
| `src-tauri/src/watchdog.rs` | Runaway recording detection (stale callback count) |
| `src-tauri/src/state.rs` | AppState struct holding audio buffer and recording state |

---

### 3B. Transcription Layer

**File**: `src-tauri/src/transcribe.rs`

#### Local Whisper (Metal GPU)

| Check | What to Look For |
|-------|-----------------|
| Model loaded? | `whisper_ctx` in AppState is `Some(...)` |
| Metal GPU warm-up? | First transcription may be slow — warm-up runs after model load |
| Speech detection gate? | RMS energy threshold — may reject quiet/paused recordings |
| Hallucination filter? | Known hallucination phrases filtered out |
| Sample count > 0? | `std::mem::take` should move samples from buffer (zero-copy) |
| Silence guard? | Long pauses may cause silence detection to reject recording |

#### Cloud (Groq API)

| Check | What to Look For |
|-------|-----------------|
| API key valid? | Groq API key stored in settings |
| Network reachable? | Can reach `api.groq.com` |
| WAV encoding correct? | Must be 16kHz mono PCM |
| Response parsing? | Groq returns JSON with transcription text |

#### Common to Both

| Check | What to Look For |
|-------|-----------------|
| Samples moved? | `std::mem::take` on audio buffer — zero-copy move, buffer should be empty after |
| Sample count? | If 0 samples, recording didn't capture audio (check Audio Layer) |
| Transcription mode? | Settings store determines local vs. cloud |

**Key files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/transcribe.rs` | Local whisper-rs + Groq cloud transcription |
| `src-tauri/src/state.rs` | AppState with whisper_ctx, audio buffer |

---

### 3C. macOS Permissions Layer

**File**: `src-tauri/src/permissions.rs`

| Check | What to Look For |
|-------|-----------------|
| Microphone entitlement | Must be `com.apple.security.device.audio-input` (NOT `.device.microphone`) |
| Accessibility entitlement | Required for fn key monitoring and CGEvent paste |
| TCC state | `tccutil reset Microphone ai.linty.desktop` clears stale entries |
| Launch method | Terminal launch bypasses entitlement checks — ALWAYS test from Finder/DMG |
| LSUIElement | Must NOT be in Info.plist — prevents TCC prompts on macOS Sequoia |
| TCC prompt shown? | If denied once, `requestAccessForMediaType:` returns false without re-prompting |

**CRITICAL gotchas**:
- **Wrong entitlement key** (`device.microphone` instead of `device.audio-input`) = TCC silently denies without ever showing a prompt
- **LSUIElement=true** in Info.plist prevents TCC prompts on macOS Sequoia entirely
- **Terminal launch** (`./Linty.app/Contents/MacOS/linty`) bypasses entitlement checks — permissions appear to work but won't in Finder launch
- Once denied, user must manually go to System Settings > Privacy & Security to re-enable

**Key files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/permissions.rs` | Microphone + accessibility permission FFI (AVFoundation) |
| `src-tauri/Entitlements.plist` | macOS Hardened Runtime entitlements |
| `src-tauri/Info.plist` | macOS app info (usage descriptions for TCC prompts) |

---

### 3D. Fn Key Layer

**File**: `src-tauri/src/fnkey.rs`

| Check | What to Look For |
|-------|-----------------|
| NSEvent monitor registered? | Accessibility permission must be granted for global key monitoring |
| Events emitting? | `fnkey-pressed` and `fnkey-released` events via Tauri event system |
| Accessibility permission? | Required for NSEvent global monitor — without it, fn key is invisible |
| Post-sleep recovery? | Fn key monitor may need reinit after macOS sleep/wake |
| Double trigger? | Debounce or state machine issue — press/release firing multiple times |
| Stuck recording? | `fnkey-released` never fires — watchdog should catch this |

**Key files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/fnkey.rs` | NSEvent fn key monitoring (global event tap) |
| `src-tauri/src/watchdog.rs` | Runaway recording recovery |

---

### 3E. Clipboard/Paste Layer

**Files**: `src-tauri/src/clipboard.rs`, `src-tauri/src/paste.rs`

| Check | What to Look For |
|-------|-----------------|
| Snapshot working? | NSPasteboard contents saved before writing transcription text |
| Text written? | Transcription text written to clipboard before paste |
| CGEvent Cmd+V? | Simulated keystroke requires accessibility permission |
| Timing correct? | Paste must happen after text is written to clipboard |
| Restore working? | Original clipboard contents restored after paste |
| Accessibility granted? | CGEvent simulation requires accessibility permission |

**Key files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/clipboard.rs` | NSPasteboard snapshot and restore |
| `src-tauri/src/paste.rs` | CGEvent Cmd+V simulation |

---

### 3F. Capsule Overlay Layer

**File**: `src-tauri/src/capsule.rs`

| Check | What to Look For |
|-------|-----------------|
| NSPanel initialized? | Always-on-top, no focus steal, transparent background |
| Show/hide commands? | Tauri commands to show/hide capsule working |
| Z-order correct? | NSPanel should float above all windows |
| Post-sleep recovery? | Panel may need reinit after macOS sleep/wake |
| Two-window architecture? | Main app window + capsule overlay are separate windows |

**Key files**:

| File | Purpose |
|------|---------|
| `src-tauri/src/capsule.rs` | NSPanel overlay (always-on-top, no focus) |
| `src/components/CapsulePanel.component.tsx` | Capsule React component |

---

### 3G. Frontend Layer

#### Data Flow Tracing

Trace the full data path for the broken feature:

```
Tauri event (fnkey-pressed/released)
    |
    v
useRecording.hook.ts → listens for events → invokes Tauri commands
    |
    v
Zustand store slices → recording, transcription, settings, history, toast
    |
    v
React components → Dashboard, Settings, History pages → DOM
```

**Common frontend bugs**:
- Tauri event listener not registered (missing `listen()` in hook)
- IPC `invoke()` call returns error but error not handled
- Zustand slice not updating (selector returning stale reference)
- Missing loading/error state handling
- Navigation state out of sync

#### Debugging Checklist

| Area | What to Check |
|------|---------------|
| Tauri events | Are `fnkey-pressed`/`fnkey-released` events reaching the frontend? |
| IPC calls | Do `invoke('start_recording')` / `invoke('stop_recording')` succeed? |
| Store state | Are Zustand slices (recording, transcription) updating correctly? |
| Components | Are pages (Dashboard, Settings, History) rendering without errors? |
| Console | Any JavaScript errors or React warnings? |

**Key files**:

| File | Purpose |
|------|---------|
| `src/hooks/useRecording.hook.ts` | Recording lifecycle hook |
| `src/hooks/useTranscription.hook.ts` | Transcription hook |
| `src/store/slices/recording.slice.ts` | Recording state management |
| `src/store/slices/transcription.slice.ts` | Transcription state management |
| `src/store/slices/settings.slice.ts` | Settings state management |
| `src/store/slices/history.slice.ts` | History state management |
| `src/store/slices/toast.slice.ts` | Toast notification state |

---

### 3H. Build & Compilation

#### Build Commands

| Command | Scope | Purpose |
|---------|-------|---------|
| `yarn build` | Frontend | TypeScript check + Vite production build |
| `cd src-tauri && cargo check --features local-stt` | Rust | Type check Rust backend |
| `cd src-tauri && cargo build --features local-stt` | Rust | Build Rust backend |
| `yarn tauri dev` | Full app | Run Tauri app in dev mode (frontend + Rust) |
| `yarn build:mac` | Full app | Release build: sign + notarize .app + .dmg |

#### Common Build Issues

| Error Pattern | Cause | Fix |
|--------------|-------|-----|
| whisper-rs functions not found | Missing `--features local-stt` | Add `--features local-stt` to cargo command |
| TypeScript errors | Frontend type mismatch | Fix types, run `yarn build` to verify |
| Cargo compilation error | Rust code issue | Run `cargo check --features local-stt` for details |
| Tauri command not found | Command not registered in `lib.rs` | Add command to `tauri::Builder` invoke handler |
| Linker errors (Metal/Accelerate) | Missing macOS frameworks | Check Cargo.toml for framework dependencies |
| `tauri::command` macro error | Wrong function signature | Check Tauri v2 command signature requirements |

---

## Phase 4: DIAGNOSE — Hypothesis Formation

**Google SRE**: _"Apply divide-and-conquer. Simplify and reduce. Test component interfaces with known inputs."_

### 4.1 Formulate Hypotheses

Based on signals collected in Phase 3, form 2-3 ranked hypotheses:

```
Hypothesis 1 (most likely): <description>
  Evidence for: <what supports this>
  Evidence against: <what contradicts this>
  Test: <how to confirm/refute>

Hypothesis 2: <description>
  Evidence for: ...
  Evidence against: ...
  Test: ...
```

### 4.2 Prioritization Rules

**Google SRE**: _"Not all failures are equally probable. Prefer simpler explanations."_

| Priority | Principle |
|----------|-----------|
| 1st | **Recent changes** — what changed since it last worked? |
| 2nd | **Simple explanations** — Occam's Razor (typo > architecture flaw) |
| 3rd | **Common patterns** — known gotchas from CLAUDE.md and memory |
| 4th | **System events** — did macOS sleep/wake? Was there an OS update? |
| 5th | **Correlation != causation** — verify, don't assume |

### 4.3 Known Gotchas (Linty-Specific)

Check these FIRST — they explain most issues:

| Gotcha | Symptom |
|--------|---------|
| Wrong mic entitlement key (`device.microphone`) | TCC silently denies, no prompt ever shown |
| LSUIElement in Info.plist | Prevents TCC prompts on macOS Sequoia |
| Terminal launch (`./Linty.app/Contents/MacOS/linty`) | Bypasses entitlement checks, permissions appear to work |
| Missing `--features local-stt` | Whisper model functions not available, compilation errors |
| Audio buffer not growing | cpal stream silently failed — check input device availability |
| Blank transcription | Silence guard rejected recording (RMS energy too low) |
| Hallucinated text | Whisper hallucination phrase filter not catching a new phrase |
| Paste not working | Accessibility permission not granted for CGEvent simulation |
| Capsule not showing | NSPanel not initialized or lost after macOS wake |
| Fn key not detected | Accessibility permission required for NSEvent global monitor |
| Metal GPU cold start | First transcription slow — warm-up step needed after model load |
| Post-sleep failures | Audio stream, fn key monitor, or capsule panel may need reinit |
| Zero samples after recording | `std::mem::take` moved an empty buffer — recording never captured |

---

## Phase 5: TEST & TREAT — Verify Hypotheses

### 5.1 Test Each Hypothesis

For each hypothesis, design a minimal test:

| Test Type | When to Use | Example |
|-----------|-------------|---------|
| **Tauri log** | Check if Rust backend receives commands | Add `log::debug!` in the Tauri command handler; read `~/Library/Logs/ai.linty.desktop/linty.log` or the `yarn tauri dev` terminal |
| **Frontend console.log** | Check if events arrive in React | Add log in event listener callback |
| **Breakpoint** | Complex logic flow | VS Code + `rust-analyzer` or browser DevTools |
| **Cargo test** | Isolated Rust logic bug | Write a unit test reproducing the failure |
| **Permission check** | macOS TCC issue | System Settings > Privacy & Security > Microphone/Accessibility |
| **Git bisect** | Regression timing | `git log --oneline -20` then check suspect commits |
| **Device test** | Audio device issue | Check System Settings > Sound > Input for available devices |
| **Fresh install test** | TCC state corrupted | `tccutil reset Microphone ai.linty.desktop` then relaunch from Finder |

### 5.2 Document Findings

As each test runs, record:
```
Test: <what was tested>
Result: <confirmed/refuted>
Finding: <what was learned>
Next: <what to test next, or proceed to fix>
```

### 5.3 Apply Fix

Once root cause is confirmed:

1. **Fix the root cause** — not the symptom
2. **No band-aids** — no `unwrap_or_default()` to mask missing data, no silent error swallowing
3. **Single fix** — address one root cause, don't mix in refactoring
4. **Remove any temporary debug code** — `println!`, `console.log`, `dbg!` macros

---

## Phase 6: BUILD VERIFICATION (Mandatory)

**After every fix, run the build to verify compilation and catch regressions.**

### 6.1 Run Build

Execute based on which layer(s) were modified:

```bash
# If Rust backend was modified
cd src-tauri && cargo check --features local-stt

# If frontend was modified
yarn build

# If both were modified
yarn build && cd src-tauri && cargo check --features local-stt

# Full app test (launches the app)
yarn tauri dev
```

### 6.2 Verify Fix

- Reproduce the original issue — confirm it no longer occurs
- Check for regressions — verify related features still work
- Check for debug code left behind:

```bash
# Search for leftover debug code in changed files
git diff --name-only | xargs grep -n "console\.log\|println!\|dbg!\|eprintln!\|debugger\|TODO.*debug" 2>/dev/null
```

### 6.3 Build Failure Recovery

If the build fails after your fix:

| Build Error | Action |
|-------------|--------|
| Rust compilation error in changed file | Fix the error — your fix introduced it |
| Rust error in untouched file | Pre-existing — note it, don't fix in this scope |
| TypeScript error in changed file | Fix the type error |
| Missing Cargo feature | Add `--features local-stt` to cargo command |
| Linker error | Check framework dependencies in Cargo.toml |
| Tauri command signature mismatch | Check Tauri v2 docs for correct command signature |

---

## Phase 7: REPORT — Present Findings

### 7.1 Summary to User

Present a concise debug report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DEBUG COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Symptom:    <what was reported>
Root Cause: <confirmed cause>
Category:   <see categories below>
Fix:        <what was changed>

Files Modified:
- <file1>: <what changed>
- <file2>: <what changed>

Build:      PASS / FAIL
Verified:   <how the fix was confirmed>

Methodology: Google SRE hypothetico-deductive
Hypotheses tested: <N>
Layers checked: <list of layers examined>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Skill: /debug
File:  .claude/skills/debug/SKILL.md
```

### 7.2 Issue Categories

| Category | Description |
|----------|-------------|
| **Audio Issue** | cpal stream failure, wrong device, sample rate, buffer empty |
| **Transcription Issue** | Whisper model not loaded, silence guard rejection, Groq API failure |
| **macOS Permission** | TCC denial, wrong entitlement, accessibility not granted |
| **Fn Key Issue** | NSEvent monitor failure, stuck state, double trigger |
| **Clipboard/Paste** | NSPasteboard failure, CGEvent simulation failure, timing issue |
| **Capsule Issue** | NSPanel not initialized, z-order wrong, lost after wake |
| **Frontend Bug** | React rendering, Zustand state, Tauri event/IPC failure |
| **Build Error** | TypeScript, Rust compilation, missing Cargo features |
| **Config Error** | Missing settings, wrong entitlements, Info.plist issue |
| **Race Condition** | Timing-dependent failure, concurrent state access |
| **Post-Sleep** | System wake recovery — audio, fn key, or capsule needs reinit |
| **Regression** | Working code broken by recent change |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | App setup, all Tauri commands, window management |
| `src-tauri/src/state.rs` | AppState struct (audio buffer, whisper ctx, recording state) |
| `src-tauri/src/audio.rs` | cpal audio capture, 16kHz resampling |
| `src-tauri/src/transcribe.rs` | Local whisper-rs + Groq cloud transcription |
| `src-tauri/src/fnkey.rs` | Fn key NSEvent monitoring |
| `src-tauri/src/permissions.rs` | Microphone + accessibility permission FFI |
| `src-tauri/src/clipboard.rs` | NSPasteboard snapshot/restore |
| `src-tauri/src/paste.rs` | CGEvent Cmd+V simulation |
| `src-tauri/src/capsule.rs` | NSPanel overlay |
| `src-tauri/src/watchdog.rs` | Runaway recording detection |
| `src-tauri/Entitlements.plist` | macOS Hardened Runtime entitlements |
| `src-tauri/Info.plist` | macOS app info (usage descriptions) |
| `src/hooks/useRecording.hook.ts` | Recording lifecycle hook |
| `src/hooks/useTranscription.hook.ts` | Transcription hook |
| `src/store/slices/recording.slice.ts` | Recording state |
| `src/store/slices/transcription.slice.ts` | Transcription state |
| `src/store/slices/settings.slice.ts` | Settings state |
| `src/store/slices/history.slice.ts` | History state |

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Can't reproduce the issue | Ask user for exact steps, check if intermittent (race condition or post-sleep) |
| Issue only happens after sleep | Focus on system wake recovery — audio, fn key, capsule reinit |
| Issue only from Finder launch | Entitlement/TCC issue — terminal launch bypasses checks |
| Multiple root causes found | Fix the primary cause first, note secondary causes |
| Fix introduces new errors | Revert fix, re-analyze with new information |
| Build fails after fix | Treat build failure as Phase 3H, fix before reporting |
| Root cause is in a dependency | Document finding, check if upgrade available (cpal, whisper-rs, tauri) |

---

## Tips

### Maximize Efficiency
- Run Phase 2 health checks in PARALLEL — they're independent
- Check recent `git log` FIRST — most bugs are regressions
- Read the error message completely before forming hypotheses
- Don't guess — read the actual code at the failure point
- Check macOS permissions early — they cause the most confusing silent failures

### Avoid Common Pitfalls (Google SRE)
- **Recency bias**: Don't assume the bug is the same as last time
- **Correlation != causation**: Two things happening together doesn't mean one caused the other
- **Occam's Razor**: Simpler explanations are more likely (typo > architecture flaw)
- **Don't brute force**: If one approach isn't working, step back and reconsider
- **Terminal vs Finder**: Always verify the issue from a Finder launch — terminal bypasses entitlements

### Debug Efficiently
- Read `~/Library/Logs/ai.linty.desktop/linty.log` (or the `yarn tauri dev` terminal) for backend issues before adding logging; new lines use `log::` macros, never print macros, and never log transcript text
- Use browser DevTools console for frontend issues
- Check macOS System Settings > Privacy & Security before diving into code
- Verify the audio device is available before assuming cpal is broken
- Check if the issue is post-sleep before investigating code bugs
- Clean up ALL debug artifacts before finishing

---

## Self-Healing

**After every `/debug` execution**, run this phase to keep the skill accurate.

### Evaluate Skill Accuracy

Re-read this skill file and compare its instructions against what actually happened:

| Check | What to look for |
|-------|-----------------|
| **Build commands** | Did `cargo check --features local-stt` and `yarn build` work as documented? |
| **File paths** | Are referenced files still at their documented locations? |
| **Error patterns** | Did issue categories match the actual issue found? |
| **Gotchas list** | Should new gotchas be added based on this debug session? |
| **Layer descriptions** | Did the debugging layers accurately describe the system? |
| **macOS behaviors** | Any new macOS version quirks discovered? |

### Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Keep changes minimal and targeted
3. Log each fix:

```
Self-Healing Log:
- Fixed: <what was wrong> → <what it was changed to>
- Reason: <why the original was inaccurate>
```

If nothing needs fixing, skip silently.

### Append Attribution

**Output summary** displayed to the user:
```
Skill: /debug
File:  .claude/skills/debug/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/debug/SKILL.md
```
