---
name: code-optimizer
user-invocable: true
disable-model-invocation: false
description: Analyzes code changes against Linty project patterns and catches common issues. Runs checks for dead code, typing violations, missed reuse opportunities, Rust anti-patterns, frontend anti-patterns, and file organization issues. Triggers on "optimize", "review code", "check code", "code review".
---

# Code Optimizer

Analyzes code in the Linty project against known patterns and project conventions. Catches issues that linters miss: architectural anti-patterns, missed reuse opportunities, naming violations, and Linty-specific gotchas (macOS FFI, audio threading, Tauri IPC).

## When to Use

- Before committing changes (`/code-optimizer` on staged files)
- After implementing a feature (review changed files)
- During code review of a PR
- When refactoring existing code
- When onboarding to an unfamiliar area of the codebase

---

## Project Context

**Single app**: Tauri v2 + React 19 + Rust macOS voice-to-text desktop app
**GitHub**: `shekhardtu/linty`

| Layer | Path | Stack |
|-------|------|-------|
| Frontend | `src/` | React 19 + Vite 6 + Tailwind CSS 4 + Zustand 5 + Lucide icons |
| Backend | `src-tauri/src/` | Rust + Tauri 2 + cpal (audio) + whisper-rs (local STT) + reqwest (Groq cloud) |
| macOS FFI | `src-tauri/src/` | objc2, cocoa (fn key, clipboard, permissions, paste, capsule) |

**File naming convention**: `Name.type.ext` (two-dot pattern)
- Components: `ComponentName.component.tsx`
- Dialogues/Modals: `DialogueName.dialogue.tsx`
- Pages: `PageName.page.tsx`
- Layouts: `LayoutName.layout.tsx`
- Stores: `name.store.ts`
- Slices: `name.slice.ts`
- Hooks: `useName.hook.ts`
- Services: `name.service.ts`
- Types: `name.types.ts`
- Config: `name.config.ts`
- Utilities: `name.util.ts`

---

## Phase 1: GATHER

Identify the files to analyze.

### Option A: Changed files (default)

```bash
# Staged + unstaged changes vs main (TS/TSX + Rust)
git diff main --name-only -- '*.ts' '*.tsx' '*.rs'
```

### Option B: Specific path (if user provides one)

```bash
# All TS/TSX/RS files under the given path
find <path> -name '*.ts' -o -name '*.tsx' -o -name '*.rs' | head -100
```

### Option C: PR files

```bash
gh pr diff <pr-number> --name-only | grep -E '\.(ts|tsx|rs)$'
```

Read every file in the changeset. If there are more than 30 files, batch into groups and analyze incrementally.

---

## Phase 2: ANALYZE

Run every check below against every file in the changeset. Track findings as a flat list of `{ file, line, code, severity, message }` objects.

### Severity Levels

| Level | Meaning |
|-------|---------|
| **ERROR** | Must fix before merging. Will cause bugs, crashes, or violates critical conventions. |
| **WARN** | Should fix. Degrades quality, maintainability, or violates project conventions. |
| **INFO** | Consider fixing. Minor improvement or style suggestion. |

---

### Category: Cleanup

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `LOG` | ERROR | No `console.log` / `console.debug` / `console.info` in production code | Grep for `console\.(log\|debug\|info)`. Exclude test files (`*.test.*`, `*.spec.*`) and scripts (`scripts/`). |
| `DEAD` | WARN | No dead code: commented-out code blocks, unused functions, unreachable branches | Look for `// ...code...` blocks >3 lines, functions with zero call sites in the changeset, `if (false)` or `return` followed by code. |
| `DEBUG` | ERROR | No debug/test flags left in committed code | Grep for `debugger`, `// TODO: remove`, `// HACK`, `// FIXME`, `// @ts-ignore` (prefer `@ts-expect-error` with explanation), `enabled: false` on features that should be on. In Rust: `dbg!()`, `println!()` debug macros. |
| `UNUSED_IMPORT` | WARN | No unused imports | Check each import — is it referenced in the file body? In Rust, check for `#[allow(unused_imports)]` hiding real issues. |

---

### Category: Typing

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `ANY` | ERROR | No `any` type usage in TypeScript | Grep for `: any`, `as any`, `<any>`, `Record<string, any>`. Suggest the correct type or `unknown`. |
| `PROPS` | WARN | All React components must have typed props interface | Find `const X: FC = ` or `function X(props)` without a typed props parameter. Every component should have `FC<XProps>` or `(props: XProps)`. |
| `UNWRAP` | ERROR | No `.unwrap()` in new Rust code | Grep for `.unwrap()` in changed `.rs` files. Use `?` operator or proper error handling (`anyhow`, `thiserror`). Exception: test code and cases with a safety comment explaining why unwrap is acceptable. |
| `UNSAFE` | WARN | Minimize `unsafe` blocks in Rust — document why each one is necessary | If a new `unsafe` block is added, check it has a `// SAFETY:` comment. macOS FFI (objc2, cocoa) requires unsafe — ensure the comment explains the invariant. |

---

### Category: Reuse

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `ZUSTAND` | WARN | Use Zustand store slices for global state (not React Context) | If a file creates a new `React.createContext` for global state, suggest a Zustand store slice instead. Check `src/store/slices/` for existing slices. |
| `HOOKS` | INFO | Check existing hooks before creating new ones | If a file creates a `useXxx` hook, search `src/hooks/` for similar existing hooks. |
| `TAURI_CMD` | WARN | Use existing Tauri commands before creating new IPC | If adding a new `#[tauri::command]` in Rust, check if an existing command already handles the functionality. Review `src-tauri/src/lib.rs` for registered commands. |
| `SHARED_TYPES` | INFO | Check for existing type definitions | If a file defines a new type/interface, check `src/types/` for existing type definitions that could be reused or extended. |

---

### Category: Rust Patterns (src-tauri/src/)

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `MUTEX_SCOPE` | ERROR | Keep Mutex lock scopes minimal — don't hold across await points | If a `Mutex::lock()` or `.lock().unwrap()` guard is held across an `.await` call, flag it. The lock should be dropped before awaiting. Pattern: `{ let guard = mutex.lock(); /* use guard */ }` then await. |
| `ARC_CLONE` | WARN | Clone Arc before moving into closures/threads | If an `Arc` is moved into a `move` closure or `std::thread::spawn` without being cloned first, flag it. Pattern: `let state = Arc::clone(&state); move \|\| { /* use state */ }`. |
| `ERROR_HANDLING` | ERROR | Use `Result<T, E>` and `?` operator, not `.unwrap()` | If new code uses `.unwrap()` or `.expect()` in non-test functions without a safety comment, flag it. Tauri commands should return `Result<T, String>` or a custom error type. |
| `FFI_SAFETY` | WARN | All ObjC FFI (objc2, cocoa) must be in unsafe blocks with safety comments | If `msg_send!`, `objc2` calls, or raw pointer operations lack a `// SAFETY:` comment, flag it. |
| `THREAD_SAFETY` | ERROR | Audio thread code must not allocate | If code inside an audio callback (cpal stream callback) uses `Vec::push`, `String::new`, `format!()`, `println!()`, or any allocating operation, flag it. Audio callbacks run on a real-time thread. |
| `ZERO_COPY` | WARN | Audio samples must never cross IPC — use `std::mem::take` for buffer moves | If audio sample data (`Vec<f32>`) is being serialized/deserialized through Tauri IPC (`invoke`), flag it. Samples should stay in Rust `AppState` and be accessed via `std::mem::take`. |
| `FEATURE_GATE` | ERROR | whisper-rs code must be behind `#[cfg(feature = "local-stt")]` | If whisper-rs imports, `WhisperContext`, or local transcription code is not gated behind the `local-stt` feature flag, flag it. |

---

### Category: Frontend Patterns (src/)

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `EFFECT` | WARN | No unnecessary `useEffect` — prefer derived state | If a `useEffect` sets state that could be computed directly from existing state/props (derived state), suggest `useMemo` or inline computation. Pattern: `useEffect(() => { setX(compute(a, b)) }, [a, b])` -> `const x = useMemo(() => compute(a, b), [a, b])`. |
| `MEMO` | INFO | Expensive computations should use `useMemo` | If a render body contains `.filter()`, `.map()`, `.reduce()`, `.sort()` on arrays that don't change every render, suggest `useMemo`. |
| `CALLBACK` | INFO | Handlers passed as props should use `useCallback` | If an inline arrow function is passed as a prop to a child component (especially in lists), suggest `useCallback`. |
| `LOADING` | WARN | All async operations must have loading states | If Tauri `invoke()` calls or async operations are used without a loading state variable, flag it. Every transcription, recording, or settings save should show loading feedback. |
| `ERROR_UI` | WARN | All async operations must have error states | If Tauri `invoke()` calls lack error handling (`.catch()` or try/catch), flag it. Errors should be displayed to the user via toast or inline message. |
| `CN_UTILITY` | INFO | Use `cn()` for conditional Tailwind classes | If ternary expressions build className strings instead of using the `cn()` utility, suggest it. |
| `TAURI_INVOKE` | WARN | Use properly typed Tauri `invoke()` calls | If a Tauri `invoke()` call lacks generic type annotation for the response (`invoke<ResponseType>('command')`), flag it. Raw untyped IPC leads to runtime errors. |

---

### Category: File Organization

| Code | Severity | Check | How to Detect |
|------|----------|-------|---------------|
| `FILE_NAME` | WARN | Follow two-dot naming convention | If a `.tsx` component file is named `MyComponent.tsx` instead of `MyComponent.component.tsx`, flag it. Similarly for pages, hooks, stores, slices, services, types, dialogues/modals. |
| `FILE_SIZE` | WARN | No files >500 lines | Check line count. If >500, suggest extracting into separate files. |
| `IMPORT_ORDER` | INFO | External libs -> `@/` path aliases -> relative imports (`./`, `../`) | Check if imports are grouped and ordered correctly. |
| `DIALOGUE` | WARN | Modal/dialog components must use `.dialogue.tsx` extension | If a component renders `<Dialog>`, `<AlertDialog>`, or any modal overlay and is NOT named `.dialogue.tsx`, flag it. |
| `COMPONENT_ORDER` | INFO | React component internals should follow standard order | Check: 1) Zustand stores, 2) Hooks, 3) Local state, 4) Derived/memo, 5) Callbacks, 6) Effects, 7) Render. |

---

## Phase 3: REPORT

Present findings grouped by severity, then by category.

### Report Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CODE OPTIMIZER REPORT — shekhardtu/linty
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Files analyzed: <count>
Issues found:  <count> (<errors> errors, <warnings> warnings, <infos> info)

── ERRORS (must fix) ──────────────────────────────────

[LOG] src/pages/Settings.page.tsx:42
  console.log('debug settings:', data);
  Fix: Remove console.log statement.

[UNWRAP] src-tauri/src/transcribe.rs:87
  let result = model.full(params, &samples).unwrap();
  Fix: Use `?` operator: `model.full(params, &samples)?`

[MUTEX_SCOPE] src-tauri/src/audio.rs:55
  let guard = state.buffer.lock().unwrap();
  let text = transcribe(&guard).await;  // holding lock across await!
  Fix: Copy data out, drop lock, then await:
    let samples = { let guard = state.buffer.lock().unwrap(); guard.clone() };
    let text = transcribe(&samples).await;

[FEATURE_GATE] src-tauri/src/transcribe.rs:3
  use whisper_rs::WhisperContext;  // not behind #[cfg(feature = "local-stt")]
  Fix: Wrap in `#[cfg(feature = "local-stt")]`

[THREAD_SAFETY] src-tauri/src/audio.rs:33
  buffer.lock().unwrap().push(sample);  // Vec::push in audio callback
  Fix: Use a lock-free ring buffer, or pre-allocate and write by index.

── WARNINGS (should fix) ──────────────────────────────

[EFFECT] src/hooks/useTranscription.hook.ts:28
  useEffect(() => { setStatus(isRecording ? 'recording' : 'idle') }, [isRecording]);
  Fix: Replace with derived state:
    const status = useMemo(() => isRecording ? 'recording' : 'idle', [isRecording]);

[FILE_NAME] src/components/ConfirmDialog.tsx
  Fix: Rename to ConfirmDelete.dialogue.tsx (modal component using overlay).

[UNSAFE] src-tauri/src/fnkey.rs:45
  unsafe { msg_send![...] }  // no SAFETY comment
  Fix: Add `// SAFETY: ...` explaining why this ObjC call is sound.

[TAURI_INVOKE] src/services/transcription.service.ts:12
  const result = await invoke('transcribe_buffer');
  Fix: Add type annotation: `invoke<TranscriptionResult>('transcribe_buffer')`

── INFO (consider fixing) ──────────────────────────────

[MEMO] src/components/WaveformVisualizer.component.tsx:18
  const normalizedSamples = samples.map(s => s / maxAmplitude);
  Fix: Wrap in useMemo to avoid recomputing on every render.

[IMPORT_ORDER] src/pages/Onboarding.page.tsx:1-8
  Relative import before @/ alias import.
  Fix: Reorder: external libs -> @/ imports -> ./ imports.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Category           | Errors | Warnings | Info |
|--------------------|--------|----------|------|
| Cleanup            | 1      | 0        | 0    |
| Typing             | 1      | 1        | 0    |
| Reuse              | 0      | 0        | 0    |
| Rust Patterns      | 3      | 0        | 0    |
| Frontend Patterns  | 0      | 1        | 1    |
| File Organization  | 0      | 1        | 1    |
|--------------------|--------|----------|------|
| TOTAL              | 5      | 3        | 2    |

Recommendation: Fix all ERRORS before merging. Address WARNINGS
in this PR if scope allows, otherwise create follow-up issues.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Skill: /code-optimizer
File:  .claude/skills/code-optimizer/skill.md
```

---

## Phase 4: AUTO-FIX (Optional)

If the user requests fixes (`/code-optimizer --fix`), apply automatic fixes for safe categories only:

### Safe to auto-fix:
- `LOG` — Remove `console.log` / `console.debug` / `console.info` statements
- `UNUSED_IMPORT` — Remove unused imports (TS and Rust)
- `IMPORT_ORDER` — Reorder imports to match convention
- `CN_UTILITY` — Replace ternary className with `cn()` calls
- `DEBUG` — Remove `dbg!()` macros in Rust

### NOT safe to auto-fix (require human judgment):
- `ANY` — Choosing the correct type requires context
- `EFFECT` — Refactoring effects needs understanding of intent
- `FILE_NAME` — Renaming files affects imports across the codebase
- `MUTEX_SCOPE` — Restructuring lock scopes requires understanding concurrency intent
- `THREAD_SAFETY` — Audio thread fixes require architectural decisions
- `UNWRAP` — Choosing the right error handling path requires context
- `ZERO_COPY` — Changing data flow requires understanding the audio pipeline
- Everything in the FFI_SAFETY category

For auto-fixes:
1. Read the file
2. Apply the fix using Edit tool
3. Mark the finding as `FIXED` in the report
4. After all fixes, verify:
   - TypeScript: `yarn build` (includes typecheck)
   - Rust: `cd src-tauri && cargo check --features local-stt`

---

## Phase 5: SELF-HEALING

**After every `/code-optimizer` execution**, run this phase to keep the skill accurate.

### 5.1 Evaluate Skill Accuracy

Re-read this skill file and compare its instructions against what actually happened during execution:

| Check | What to look for |
|-------|-----------------|
| **Check codes** | Did any check produce false positives consistently? Should thresholds or patterns be adjusted? |
| **File paths** | Did referenced paths (`src/`, `src-tauri/src/`) still match the actual codebase structure? |
| **Tool names** | Did grep patterns or glob patterns fail to match expected files? |
| **Stack accuracy** | Did the project context section (React 19, Tauri 2, Rust, etc.) match reality? |
| **New patterns** | Did the codebase introduce new conventions not yet covered by a check code? |
| **False negatives** | Were there issues found manually that no check code caught? |

### 5.2 Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Keep changes minimal and targeted — fix only what is wrong
3. Log each fix:

```
Self-Healing Log:
- Fixed: <what was wrong> -> <what it was changed to>
- Reason: <why the original was inaccurate>
```

If nothing needs fixing, skip silently.

### 5.3 Common Self-Healing Scenarios

| Scenario | Action |
|----------|--------|
| New Tauri command added | No change needed — `TAURI_CMD` check already searches `src-tauri/src/lib.rs` |
| New Zustand slice added | No change needed — `ZUSTAND` check already searches `src/store/slices/` |
| whisper-rs replaced with different STT engine | Update `FEATURE_GATE` check to reference the new crate |
| New macOS FFI module added | No change needed — `FFI_SAFETY` and `UNSAFE` checks apply to all `.rs` files |
| Audio capture library changed from cpal | Update `THREAD_SAFETY` check with the new library's callback patterns |
| File naming convention changes | Update convention table and `FILE_NAME` check |
| Frontend framework upgrade (React 19 -> future) | Update Frontend Patterns category with new patterns |

---

## Quick Commands

These commands help manually spot-check before running the full optimizer:

```bash
# Find console.log in changed files
git diff main --name-only -- '*.ts' '*.tsx' | xargs grep -n "console\.\(log\|debug\|info\)" 2>/dev/null

# Find any types in changed TS files
git diff main --name-only -- '*.ts' '*.tsx' | xargs grep -n ": any\|as any\|<any>" 2>/dev/null

# Find .unwrap() in Rust code
grep -rn "\.unwrap()" src-tauri/src/ --include='*.rs' | head -20

# Large files (>500 lines)
find src src-tauri/src -name "*.tsx" -o -name "*.ts" -o -name "*.rs" | xargs wc -l 2>/dev/null | awk '$1 > 500 {print}' | sort -rn | head -20

# Find components not following naming convention
find src -name "*.tsx" | grep -v "\.component\.\|\.page\.\|\.dialogue\.\|\.layout\.\|\.test\.\|\.spec\." | head -20

# Find modals/dialogs not using .dialogue.tsx
grep -rln "<Dialog\|<AlertDialog\|<Modal" src/ --include='*.tsx' | grep -v "\.dialogue\.\|\.test\.\|\.spec\." | head -10

# Find dbg!() macros in Rust code
grep -rn "dbg!" src-tauri/src/ --include='*.rs' | head -10

# Find unsafe blocks without SAFETY comments
grep -rn -B1 "unsafe" src-tauri/src/ --include='*.rs' | grep -v "SAFETY" | head -20

# Find whisper-rs code not behind feature gate
grep -rn "whisper_rs\|WhisperContext\|WhisperState" src-tauri/src/ --include='*.rs' | head -10
```

---

## Decision Flowcharts

### Before adding new code

```
Need a UI component?
  -> Check existing components in src/components/
    -> Exists? USE IT
    -> Doesn't exist? Create in src/components/ with .component.tsx naming

Need a type?
  -> Check src/types/ for existing type definitions
  -> Check Tauri command return types in src-tauri/src/
  -> React props? Create interface in same file or co-located .types.ts
  -> None of the above? Create in src/types/

Need a hook?
  -> Check src/hooks/ for existing hooks
  -> Check if a Zustand store selector would work instead
  -> Create new hook only if neither option fits

Need state management?
  -> Truly global state (recording, settings, navigation)? Zustand store slice
  -> Local component state? useState
  -> Derived from existing state? useMemo / inline computation

Need Rust backend logic?
  -> Add Tauri command in src-tauri/src/lib.rs (register in handler)
  -> Implement in a dedicated module (src-tauri/src/<name>.rs)
  -> Use existing commands if the functionality is already available
```

### Where to put a new file

```
React component?
  -> Shared/reusable -> src/components/ (or src/components/shared/, src/components/layout/)
  -> Feature-specific -> co-locate near the feature

Page?
  -> src/pages/PageName.page.tsx

Hook?
  -> src/hooks/useName.hook.ts

Store slice?
  -> src/store/slices/name.slice.ts

Service (frontend)?
  -> src/services/name.service.ts

Types (frontend)?
  -> src/types/name.types.ts

Rust module?
  -> src-tauri/src/<name>.rs
  -> Register in src-tauri/src/lib.rs (mod + command handler)

Tauri command?
  -> Implement in src-tauri/src/<module>.rs
  -> Register in src-tauri/src/lib.rs invoke_handler
```
