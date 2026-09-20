---
name: build
user-invocable: true
disable-model-invocation: false
description: End-to-end development workflow for Linty. Researches codebase, gathers context, gets human approval, plans with sub-tasks, implements with documentation, and optionally chains into /ship. Triggers on "build this", "develop this", "implement this", "start building".
---

# Build Workflow

End-to-end development lifecycle: Intake --> Research --> Approval --> Plan --> Implement --> Quality Check --> (optional) Ship.

## When to Use

Run `/build` when you have a new task to implement:
- New feature development
- Bug investigation and fix
- Refactoring work
- Significant architectural changes
- Any task that benefits from upfront research and documentation

**This skill handles everything BEFORE `/ship`**. At the end, it optionally chains into `/ship` for branch/commit/PR creation.

---

## Phase 1: INTAKE

Collect essential information before starting. Use `AskUserQuestion` to gather:

### Required Questions

**Question 1: Priority**
- Urgent (P1) -- Blocking or critical
- High (P2) -- Important, needed soon
- Normal (P3) -- Standard work
- Low (P4) -- Nice to have

**Question 2: Type**
Determine the type of work:
- Feature (`feat`)
- Bug Fix (`fix`)
- Refactor (`refactor`)
- Documentation (`docs`)
- Chore (`chore`)

### Parse the Task

From the user's prompt, identify:
- **What**: The feature/fix/change requested
- **Why**: The business reason or user problem
- **Scope**: Which area(s) affected (frontend, rust, audio, transcribe, macos, clipboard, capsule, tauri, build)
- **URLs**: Any links provided (PRDs, Figma, API docs, external references)

---

## Phase 2: RESEARCH

Before presenting findings, autonomously gather comprehensive context. **This is critical -- the research must contain enough information for anyone to understand and implement the task.**

### 2.1 Codebase Analysis

```
Use Grep, Glob, and Read tools to:
```

1. **Find related files**: Search for components, stores, services, hooks, Rust modules related to the task
2. **Identify existing patterns**: How similar features are implemented in the codebase
3. **Check for reusable code**: Shared components, utilities, existing hooks
4. **Map dependencies**: What imports, Tauri commands, stores, IPC events the affected area uses
5. **Scan for tech debt**: TODOs, FIXMEs, and known issues in affected areas

### 2.2 Architecture Awareness

Linty is a single app with two codebases:

| Layer | Location | Key Files |
|-------|----------|-----------|
| **Frontend** (React 19 + Zustand) | `src/` | pages/, components/, hooks/, services/, store/slices/, types/, lib/ |
| **Rust Backend** (Tauri 2) | `src-tauri/src/` | lib.rs, state.rs, audio.rs, transcribe.rs, fnkey.rs, permissions.rs, clipboard.rs, paste.rs, capsule.rs, watchdog.rs, tray.rs |
| **Tauri Config** | `src-tauri/` | Cargo.toml, tauri.conf.json, Entitlements.plist, Info.plist |
| **CI/Build** | `.github/workflows/` | build-dmg.yml |

Key architectural patterns:
- **Zero-copy audio**: Samples stay in Rust (`Arc<Mutex<Vec<f32>>>`), never cross IPC
- **macOS FFI**: objc2/cocoa for fn key, clipboard, permissions, paste -- not Tauri plugins
- **Two windows**: Main app + capsule overlay (NSPanel, always-on-top)
- **Feature-gated**: `local-stt` Cargo feature enables whisper-rs + Metal GPU
- **IPC events**: `fnkey-pressed`, `fnkey-released` etc. between Rust and React
- **State**: `AppState` struct with `Arc<Mutex<>>` in Rust; Zustand store with slices in React
- **Persistence**: `tauri-plugin-store` saves settings + history to JSON files

### 2.3 Git History

```bash
# Recent changes in affected areas
git log --oneline -10 -- <affected-paths>

# Who last modified these files
git log --format='%an' -5 -- <affected-paths> | sort -u
```

### 2.4 External Context

If the user provided URLs (PRDs, Figma, docs, API specs):
- Fetch each URL using `WebFetch`
- Summarize the relevant content
- Extract acceptance criteria, design specs, or API contracts

### 2.5 Research Summary

Compile findings into a structured format. Include:
- List of affected files with their purpose
- Existing patterns to follow
- Reusable components/utilities available
- Potential risks or edge cases discovered

---

## Phase 3: RESEARCH REVIEW

Present the research findings to the user for approval before planning.

### Research Summary Template

```
-----------------------------------------------------
  BUILD RESEARCH COMPLETE
-----------------------------------------------------

Task:      [Title]
Priority:  <priority>
Type:      <type>

Summary:
<2-3 sentence summary of research findings>

Affected Files & Areas:
| File | Purpose | Action |
|------|---------|--------|
| `src/pages/Example.page.tsx` | Page component | Modify |
| `src-tauri/src/audio.rs` | Audio capture | Modify |
| `src/store/slices/recording.slice.ts` | Recording state | New |

Existing Patterns Found:
- <Pattern from codebase with file references>

Reusable Components:
- <What exists that should be reused>

Acceptance Criteria:
- [ ] <criterion 1>
- [ ] <criterion 2>
- [ ] <criterion 3>

Technical Approach:
- Approach: <description>
- Rationale: <why this approach>
- Trade-offs: <what we accept>

Estimation: <XS|S|M|L|XL|XXL>
Basis: <N files affected, new vs modify, complexity>

Risks & Edge Cases:
- <Risk 1: description + mitigation>
- <Edge case 1: handling approach>

-----------------------------------------------------
```

### Estimation Framework

Auto-calculate estimation based on research findings:

| Size | Criteria |
|------|----------|
| XS | 1 file, minor change, no new patterns |
| S | 1-2 files, follows existing pattern exactly |
| M | 2-4 files, new component but known patterns |
| L | 4-8 files, new pattern or cross-layer (React + Rust) |
| XL | 8+ files, architectural change, cross-cutting |
| XXL | System-wide impact, multiple sub-systems |

Use `AskUserQuestion` to ask:
- **"Does this research look correct? Should I proceed to planning?"**
  - Options: "Approve and proceed" / "I want to modify it" / "Cancel"

If user wants modifications:
1. Gather their feedback
2. Revise the research findings
3. Present again for approval

**Do not proceed to Phase 4 until explicitly approved.**

---

## Phase 4: PLANNING

### 4.1 Enter Plan Mode

Use `EnterPlanMode` to design the implementation strategy.

During plan mode:
1. Read all affected files identified in research
2. Understand the complete context
3. Design the step-by-step implementation approach
4. Identify what can be done in parallel vs sequentially

### 4.2 Task Breakdown

**For L-sized or larger tasks**, create sub-tasks using `TaskCreate`:

Sub-task ordering rules for Linty:
- Types/interfaces first (`src/types/`)
- Rust backend next (state, commands, core logic in `src-tauri/src/`)
- Then Zustand slices and stores (`src/store/slices/`)
- Then hooks and services (`src/hooks/`, `src/services/`)
- Then UI components and pages (`src/components/`, `src/pages/`)
- Integration/wiring last (Tauri IPC, event listeners)

### 4.3 Exit Plan Mode

Present the plan via `ExitPlanMode` for user approval.

---

## Phase 5: IMPLEMENTATION

Execute the approved plan. For each sub-task (or each step if no sub-tasks):

### 5.1 Start Task

1. Mark task as in_progress using `TaskUpdate`

### 5.2 Implement Code

Write the code following all codebase conventions from CLAUDE.md.

Follow the project's file naming conventions:
- Components: `ComponentName.component.tsx`
- Pages: `PageName.page.tsx`
- Dialogues: `DialogueName.dialogue.tsx`
- Stores: `name.store.ts`
- Slices: `name.slice.ts`
- Services: `name.service.ts`
- Hooks: `useName.hook.ts`
- Types: `name.types.ts`
- Config: `configName.config.ts`

Rust conventions:
- Tauri commands use `#[tauri::command]` and are registered in `lib.rs`
- Shared state through `AppState` struct in `state.rs`
- macOS FFI uses `objc2` / `cocoa` crates
- Feature-gated code behind `#[cfg(feature = "local-stt")]`

### 5.3 Complete Task

1. Mark task as completed using `TaskUpdate`
2. Move to next task

### 5.4 Discovery Log

If during implementation you discover:
- **New bugs**: Note for the handoff summary
- **Tech debt**: Note for the handoff summary
- **Scope creep**: Note it but do NOT implement it

---

## Phase 6: QUALITY CHECK

After all implementation is complete:

### 6.1 Verify Build

Run the appropriate build checks based on what was changed:

```bash
# Frontend changes
yarn build

# Rust backend changes
cd src-tauri && cargo check --features local-stt

# Full app (if cross-layer changes)
yarn tauri dev  # Quick smoke test
```

### 6.2 Verify Checklist

- [ ] Build passes (`yarn build` for frontend, `cargo check --features local-stt` for Rust)
- [ ] No TypeScript errors
- [ ] No Rust compiler warnings (unless pre-existing)
- [ ] No console.log statements in changed files
- [ ] No hardcoded secrets or API keys
- [ ] All acceptance criteria from the research phase are met

### 6.3 Implementation Summary

Compile the results:

| File | Action | Description |
|------|--------|-------------|
| `<path>` | Created | <purpose> |
| `<path>` | Modified | <what changed> |

Architecture Decisions:
- <Decision 1>: <chosen approach> because <reason>

Deviations from Plan:
- <Any changes from original plan, or "None">

Known Limitations:
- <Any known limitations or future work>

Discovered Issues:
- <Issue 1: description>
- Or "None discovered"

---

## Phase 7: HANDOFF

### 7.1 Ship Decision

Ask the user:
- **"Implementation is complete. Would you like to ship now?"**
  - Options: "Yes, run /ship" / "Not yet, I'll ship manually later"

If "Yes":
- Invoke the `/ship` skill to handle branch creation, commit, and PR

If "Not yet":
- Display summary of what was built

### 7.2 Final Summary

Display completion summary:

```
-----------------------------------------------------
  BUILD COMPLETE
-----------------------------------------------------

Task:           [Title]
Files Changed:  <count> (<count> new, <count> modified)
Estimation:     <size>
Status:         <current status>

Key Decisions:
- <decision 1>
- <decision 2>

Next Steps:
- <what the user should do next>

-----------------------------------------------------

Skill: /build
File:  .claude/skills/build/SKILL.md
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| User rejects research | Gather feedback, revise findings, re-present |
| Research finds existing solution | Present finding, ask user how to proceed |
| Build/typecheck fails during implementation | Fix the issue, note it in summary |
| Cargo check fails with feature gate issues | Verify correct feature flags are used |
| User cancels mid-workflow | Summarize what was done with partial status |
| Rust FFI/macOS code fails to compile | Check objc2/cocoa API compatibility, reference existing FFI patterns |

---

## State Tracking

Throughout the entire workflow, maintain awareness of:
- **Current phase** (which phase we're in)
- **Files changed** (running list of all modifications)
- **Decisions made** (running list for documentation)

Use `TaskCreate`/`TaskUpdate` to track all tasks and sub-tasks throughout the workflow.

---

## Tips

- Keep tasks focused -- one logical feature per `/build` invocation
- If research reveals the task is much larger than expected, discuss with the user before planning
- Always check existing components before creating new ones
- Follow existing patterns in the codebase -- consistency over cleverness
- For cross-layer changes (React + Rust), implement Rust side first so frontend can call it
- When adding Tauri commands, remember to register them in `lib.rs`
- Test macOS-specific features from a built `.app` (not terminal) for accurate TCC behavior
- When in doubt about scope, ask the user rather than assuming

---

## Phase 8: SELF-HEALING

**After every `/build` execution**, run this phase to keep the skill accurate.

### 8.1 Evaluate Skill Accuracy

Re-read this skill file and compare its instructions against what actually happened during execution:

| Check | What to look for |
|-------|-----------------|
| **CLI commands** | Did any `gh`, `git`, `yarn`, or `cargo` commands fail due to wrong flags or changed syntax? |
| **Workflow logic** | Did any phase need to be skipped, reordered, or modified? |
| **Templates** | Are summary templates and examples still accurate? |
| **Tool availability** | Did any referenced tool behave differently than documented? |
| **File paths** | Have any referenced file locations changed? |
| **Build commands** | Did `yarn build`, `cargo check`, or `yarn tauri dev` behave as expected? |

### 8.2 Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Keep changes minimal and targeted -- fix only what's wrong
3. Log each fix:

```
Self-Healing Log:
- Fixed: <what was wrong> --> <what it was changed to>
- Reason: <why the original was inaccurate>
```

If nothing needs fixing, skip silently.

### 8.3 Append Attribution

For the **PR description** (if `/ship` was chained), ensure skill attribution is present:

```markdown
---
*Built by [`/build`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/build/SKILL.md)*
```
