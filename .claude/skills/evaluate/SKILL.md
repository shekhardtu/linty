---
name: evaluate
user-invocable: true
disable-model-invocation: false
description: Evaluate major changes before committing to them. Researches external docs/blogs/papers, analyzes codebase blast radius, identifies risks and scary areas, defines metrics and test strategy, produces a go/no-go recommendation, and optionally chains into /build. Triggers on "evaluate this", "should we migrate", "should I implement", "is this worth it", "evaluate migration", "evaluate change", "/evaluate".
---

# Evaluate — Major Change Decision Framework

Comprehensive evaluation of major technical decisions: migrations, architectural changes, technology swaps, large refactors, or risky feature additions for the Linty macOS desktop app. Produces an evidence-based **go/no-go recommendation** with full risk analysis, blast radius mapping, metrics plan, and test strategy.

Use this BEFORE committing engineering effort to a major change. The output is an evaluation presented directly — not code.

## When to Use

Run `/evaluate` when considering:
- **Audio engine changes** (cpal -> coreaudio-rs, different resampling strategies)
- **Transcription backend swaps** (whisper-rs -> candle Whisper, local -> cloud-only)
- **Framework swaps** (Tauri v2 -> Electron, Zustand -> Redux)
- **Major dependency upgrades** (Rust edition upgrade, React 18 -> 19)
- **macOS platform changes** (minimum OS version bump, new entitlements, Metal API changes)
- **Build/distribution changes** (notarization workflow changes, new signing approach, DMG -> pkg)
- **Architecture changes** (rewrite audio pipeline, overhaul state management, change IPC strategy)
- **New technology adoption** (add CoreML, add speech VAD, add noise suppression)
- **Any change where the wrong decision is expensive to reverse**

**Do NOT use for**: small features, bug fixes, minor refactors, or changes with obvious low risk. Use `/build` directly for those.

---

## Phase 1: INTAKE

Understand exactly what is being proposed and why.

### 1.1 Parse the Proposal

From the user's prompt, identify:
- **What**: The specific change being proposed (e.g., "Swap whisper-rs for candle-based Whisper")
- **Why**: The motivation — what problem does this solve?
- **Scope**: Which systems are affected (Rust backend, React frontend, build pipeline, distribution)
- **Constraints**: Timeline pressure, macOS version support, app size limits, performance budgets

### 1.2 Clarify with User

Use `AskUserQuestion` to gather missing context:

**Question 1: Motivation**
- Performance issues with current solution (transcription speed, audio latency)
- App size concerns (Whisper model bundling, binary bloat)
- Build time improvements (whisper-rs compilation is slow)
- Developer experience / maintainability
- macOS compatibility (new OS versions, Apple Silicon requirements)
- New feature requirements that current stack can't support

**Question 2: Constraints**
- Can we do this incrementally (feature flags, dual implementation)?
- Is there a hard deadline?
- Must we maintain the same minimum macOS version?
- Are there app size constraints (DMG size, download size)?
- Must we preserve the current Cargo feature gating strategy?

**Question 3: Success Criteria**
Ask the user: "What does success look like? What specific outcome would make this change worth the effort?"

### 1.3 Define Evaluation Scope

Based on answers, define what the evaluation will cover:
- Which areas of the codebase are in scope (`src-tauri/src/`, `src/`, build scripts, CI)
- Which macOS APIs and entitlements interact with the affected areas
- Whether this is a one-shot change or incremental migration
- Whether this affects code signing, notarization, or distribution

---

## Phase 2: EXTERNAL RESEARCH

Research the proposed change using external sources. **This is the most critical phase — decisions must be evidence-based, not opinion-based.**

### 2.1 Official Documentation

Use `WebSearch` and `WebFetch` to research:
- **Migration guides**: Official docs for migrating FROM current -> TO proposed technology
- **Breaking changes**: What APIs/behaviors change between current and proposed
- **Feature parity**: Does the proposed technology support everything we currently use?
- **Known limitations**: What can't the proposed technology do?
- **macOS/Apple specifics**: Any platform-specific considerations (Metal compatibility, codesigning impacts, entitlement requirements)

### 2.2 Community Experience

Search for real-world experiences:
```
WebSearch queries (adapt to the specific change):
- "<current> to <proposed> migration experience"
- "<proposed technology> production issues"
- "<proposed technology> macOS desktop app"
- "<current> vs <proposed> 2025 comparison"
- "<proposed technology> gotchas pitfalls"
- "<proposed technology> Tauri integration"
- "<proposed technology> Apple Silicon Metal"
```

Look for:
- **Blog posts** from teams who've done this migration
- **Post-mortems** from failed migrations
- **Conference talks** on the topic
- **GitHub issues** in the proposed technology's repo (open issues, common complaints)
- **Tauri community** discussions about the proposed technology
- **Rust ecosystem** compatibility notes

### 2.3 Benchmarks & Data

Search for quantitative comparisons:
- Performance benchmarks (latency, throughput, memory, Metal GPU utilization)
- Binary size comparisons (impact on .app and .dmg size)
- Build time comparisons (compilation time, CI pipeline duration)
- Ecosystem health (crates.io downloads, GitHub stars, release frequency, maintainer activity)
- Adoption trends (is this technology growing or declining?)

### 2.4 Research Summary

Compile all findings into a structured format:

| Source | Key Finding | Relevance |
|--------|------------|-----------|
| Official docs | <finding> | <how it affects us> |
| Blog: <title> | <finding> | <how it affects us> |
| Benchmark: <source> | <finding> | <how it affects us> |
| GitHub issue #N | <finding> | <how it affects us> |

---

## Phase 3: CODEBASE IMPACT ANALYSIS

Map exactly what in the Linty codebase would be affected.

### 3.1 Dependency Mapping

Use `Grep`, `Glob`, and `Read` to find every touchpoint:

```
For an audio engine change example:
- src-tauri/src/audio.rs (cpal capture, 16kHz mono resampling)
- src-tauri/src/transcribe.rs (whisper-rs local, Groq cloud)
- src-tauri/src/state.rs (AppState: Arc<Mutex<>> for audio buffer, whisper context)
- src-tauri/src/lib.rs (Tauri command registrations, state setup)
- src-tauri/src/watchdog.rs (runaway recording recovery)
- src-tauri/Cargo.toml (dependencies, feature flags)
- src-tauri/build.rs (build-time configuration)
- src/hooks/ (recording, transcription hooks)
- src/store/slices/ (Zustand slices for recording/transcription state)
- src/services/ (permissions, paste, correction services)
- .github/workflows/ (CI build pipeline)
- scripts/build-mac.sh (release build script)
```

### 3.2 Blast Radius Assessment

Categorize every affected file by impact level:

| Impact Level | Definition | Example |
|-------------|------------|---------|
| **CRITICAL** | Must change or app won't start | Rust state management, Tauri command registration |
| **HIGH** | Must change or feature is broken | Audio capture, transcription pipeline, IPC handlers |
| **MEDIUM** | Should change but can work temporarily | Performance optimizations, error handling |
| **LOW** | Nice to change but not required | Logging, dev tooling, documentation |
| **NONE** | Not affected | Unrelated UI components, unrelated services |

### 3.3 Feature Parity Check

For each feature we currently use from the existing technology, verify:

| Feature We Use | Current Implementation | Proposed Equivalent | Gap? |
|---------------|----------------------|-------------------|------|
| <feature 1> | <how we use it> | <equivalent or N/A> | Yes/No |
| <feature 2> | <how we use it> | <equivalent or N/A> | Yes/No |

**IMPORTANT**: Features marked "Gap: Yes" are blockers or require workarounds. These are the scary areas.

### 3.4 Scary Areas

Identify the highest-risk parts of the migration:
- Areas with complex business logic tightly coupled to the current technology
- Areas with no test coverage (changes here are blind)
- `unsafe` Rust blocks (FFI calls to macOS APIs, raw pointer manipulation)
- Real-time audio pipeline constraints (latency-sensitive code paths)
- macOS entitlement dependencies (Hardened Runtime, TCC permissions)
- Code signing and notarization compatibility
- Areas with implicit dependencies (things that work "by accident")

Present these to the user with `AskUserQuestion`:
- **"I've identified these high-risk areas. Are there others I should know about?"**
  - Show the list of scary areas
  - Options: "Looks complete" / "I have additions"

---

## Phase 4: RISK ASSESSMENT

### 4.1 Risk Matrix

Categorize all identified risks:

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|----|------|-----------|--------|----------|------------|
| R1 | <description> | Low/Med/High | Low/Med/High | <L*I score> | <mitigation strategy> |
| R2 | <description> | Low/Med/High | Low/Med/High | <L*I score> | <mitigation strategy> |

**Severity scoring:**
- **Critical** (High x High): Could cause data loss, app crashes, or bricked builds
- **High** (High x Med or Med x High): Could cause significant feature degradation
- **Medium** (Med x Med): Could cause temporary issues with known workarounds
- **Low** (Low x anything or anything x Low): Minor inconvenience

### 4.2 Risk Categories

Evaluate risks across these dimensions:

| Category | What to Assess |
|----------|---------------|
| **macOS Compatibility** | Minimum OS version impact? Metal GPU requirements? Apple Silicon vs Intel? |
| **Hardened Runtime** | Does this change require new entitlements? Could it break TCC permissions? |
| **Audio Pipeline** | Real-time constraints met? Latency impact? Buffer underrun risk? |
| **FFI Safety** | New `unsafe` blocks needed? Existing FFI boundaries affected? Memory safety? |
| **Build Impact** | Compilation time change? New system dependencies? CI pipeline changes? |
| **App Size** | Binary size impact? Model bundling changes? DMG size increase? |
| **Notarization** | Code signing compatibility? New frameworks that need signing? Notarization blockers? |
| **Performance** | Transcription speed? Memory usage? CPU/GPU utilization? Battery impact? |
| **Developer Experience** | Learning curve? Tooling quality? Debugging difficulty? |
| **Rollback** | Can we reverse this? How quickly? What do we lose if we roll back? |
| **Ecosystem** | Crate/library support? Community size? Long-term maintenance? |

### 4.3 Reversibility Assessment

**This is the most important risk factor.** Classify the change:

| Reversibility | Description | Example |
|--------------|-------------|---------|
| **Easily Reversible** | Can undo in hours, no user impact | Feature flag toggle, config change |
| **Reversible with Effort** | Can undo in days, requires engineering work | Library swap with adapter pattern |
| **Partially Reversible** | Can undo most things, some changes are permanent | Audio pipeline rewrite (new architecture) |
| **Irreversible** | Cannot practically undo | Dropped macOS version support, removed Cargo feature |

---

## Phase 5: MIGRATION STRATEGY

### 5.1 Approach Options

Present 2-3 migration strategies (where applicable):

**Option A: Big Bang**
- Replace everything at once in a single PR/branch
- Pros: Simple, no dual-implementation complexity
- Cons: High risk, large diff, hard to review and test

**Option B: Strangler Fig (Incremental)**
- Gradually migrate component by component
- Feature-flag the new implementation, keep old as fallback
- Pros: Lower risk, can stop and assess, easier to review
- Cons: Longer timeline, temporary code duplication, Cargo feature complexity

**Option C: Parallel Run**
- Run both implementations simultaneously, compare results
- Gradually shift to new implementation
- Pros: Validates correctness before full cutover
- Cons: Increased binary size during transition, more complex state management

Use `AskUserQuestion` to ask the user which approach they prefer:
- Present pros/cons of each
- Options: "Option A: Big Bang" / "Option B: Incremental" / "Option C: Parallel Run"

### 5.2 Phase Breakdown

For the chosen approach, define migration phases:

| Phase | Scope | Duration Estimate | Rollback Plan |
|-------|-------|-------------------|---------------|
| 1 | <what gets migrated first> | <relative size> | <how to roll back> |
| 2 | <next batch> | <relative size> | <how to roll back> |
| N | <final batch + cleanup> | <relative size> | <how to roll back> |

---

## Phase 6: METRICS & OBSERVABILITY

### 6.1 Before Migration (Baseline)

Define metrics to capture BEFORE making any changes:

| Metric | How to Measure | Current Baseline |
|--------|---------------|-----------------|
| Transcription latency (5s audio) | Manual timing / instrumentation | <measure or "TBD"> |
| App launch time | Manual timing | <measure or "TBD"> |
| Memory usage during recording | Activity Monitor / Instruments | <measure or "TBD"> |
| App bundle size (.app) | `du -sh` on .app bundle | <measure or "TBD"> |
| DMG size | `ls -lh` on .dmg | <measure or "TBD"> |
| Build time (cargo build) | `time cargo build --features local-stt` | <measure or "TBD"> |
| CI pipeline duration | GitHub Actions timing | <measure or "TBD"> |
| <domain-specific metric> | <measurement method> | <measure or "TBD"> |

### 6.2 During Migration

Define what to monitor during the migration:

| Signal | Threshold | Action if Breached |
|--------|-----------|-------------------|
| Transcription accuracy | Noticeably worse on test recordings | Pause migration, investigate |
| Audio latency | > 50ms increase in recording start | Investigate, consider rollback |
| App size | > 2x baseline DMG size | Optimize or reconsider approach |
| Build time | > 3x baseline | Investigate compilation bottleneck |
| <custom signal> | <threshold> | <action> |

### 6.3 After Migration (Convergence)

Define success criteria — the migration is "done" when:

| Metric | Target | Measurement Period |
|--------|--------|-------------------|
| Transcription accuracy | >= baseline on test recordings | Manual testing |
| Transcription latency | <= 110% of baseline | 5 test recordings |
| App stability | No crashes in normal usage | 3 days of daily use |
| App size | Within acceptable bounds | Single measurement |
| Build succeeds | Clean build + notarization on CI | Single CI run |
| <custom metric> | <target> | <period> |

---

## Phase 7: TEST STRATEGY

### 7.1 Automated Tests

| Test Type | What to Test | Priority | Exists? |
|-----------|-------------|----------|---------|
| Cargo check | `cargo check --features local-stt` passes | P1 | Yes |
| Cargo build | `cargo build --features local-stt` succeeds | P1 | Yes |
| Frontend build | `yarn build` succeeds | P1 | Yes |
| Tauri build | Full app bundle builds without error | P1 | Yes |
| Notarization | Signed app passes `xcrun notarytool` | P1 | Yes (CI) |
| Unit tests | Affected Rust modules compile and pass | P1 | Partial |
| <migration-specific> | <what to test> | P1/P2 | Yes/No |

### 7.2 Manual Test Cases

| ID | Test Case | Steps | Expected Result | Priority |
|----|-----------|-------|-----------------|----------|
| MT1 | Basic recording + transcription | Hold fn -> speak -> release | Text appears and pastes correctly | P1 |
| MT2 | Long recording | Hold fn for 60+ seconds | Recording completes without watchdog kill | P1 |
| MT3 | Quiet recording | Hold fn in silence -> release | Handles gracefully (no crash, sensible output) | P1 |
| MT4 | Rapid toggle | Press/release fn quickly multiple times | No crash, no stuck state | P2 |
| MT5 | App launch from Finder | Double-click .app from /Applications | Launches, TCC prompt appears if needed | P1 |
| MT6 | App launch from DMG | Open DMG, run app | Launches correctly, Gatekeeper passes | P1 |
| MT7 | Microphone permission | Fresh install, first recording attempt | TCC prompt appears, recording works after grant | P1 |
| MT8 | <migration-specific> | <steps> | <expected> | P1/P2/P3 |

Focus manual tests on:
- Core voice-to-text flow (fn key -> record -> transcribe -> paste)
- macOS permission prompts (TCC / microphone access)
- App installation and launch (DMG, Finder, Gatekeeper)
- Edge cases in audio capture (silence, noise, long recordings)
- Capsule overlay behavior (appears/disappears correctly)
- Clipboard snapshot/restore (original clipboard content preserved)

### 7.3 Platform Testing

Define how to validate across macOS configurations:
- **macOS versions**: Test on minimum supported version and latest
- **Hardware**: Apple Silicon (M1+) and Intel (if still supported)
- **Metal GPU**: Verify GPU acceleration works (if applicable to change)
- **Fresh install**: Test TCC prompts and entitlements from clean state
- **Upgrade install**: Test that existing users' settings/history survive

---

## Phase 8: PRESENT EVALUATION

Present the complete evaluation directly to the user. Structure the findings as follows:

### Evaluation Report Format

```
# Evaluate: <Short Description>

> **Status**: Evaluation Complete | **Date**: <today> | **Verdict**: <PENDING>

## 1. Proposal

### What
<The specific change being proposed>

### Why
<The motivation — what problem does this solve?>

### Success Criteria
<What does success look like from the user's perspective?>

### Constraints
<Timeline, macOS compatibility, app size, performance budgets>

---

## 2. External Research

### Official Documentation
<Key findings from official docs, migration guides, feature parity>

### Community Experience
| Source | Key Finding | Relevance to Us |
|--------|------------|-----------------|
| <source> | <finding> | <relevance> |

### Benchmarks & Data
| Metric | Current (<technology>) | Proposed (<technology>) | Source |
|--------|----------------------|------------------------|--------|
| <metric> | <value> | <value> | <source> |

### Research Verdict
<1-2 sentence summary: Does external evidence support this change?>

---

## 3. Blast Radius

### Affected Files
| Impact | Count | Key Files |
|--------|-------|-----------|
| CRITICAL | <N> | <list> |
| HIGH | <N> | <list> |
| MEDIUM | <N> | <list> |
| LOW | <N> | <list> |

**Total files affected**: <N>

### Feature Parity
| Feature We Use | Equivalent in Proposed? | Gap? |
|---------------|------------------------|------|
| <feature> | <yes/no/partial> | <description if gap> |

### Scary Areas
<List of highest-risk areas with explanation of why they're scary>

---

## 4. Risk Assessment

### Risk Matrix
| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|----|------|-----------|--------|----------|------------|
| R1 | <risk> | <L/M/H> | <L/M/H> | <severity> | <mitigation> |

### Linty-Specific Risks
- **macOS Compatibility**: <assessment>
- **Hardened Runtime / Entitlements**: <assessment>
- **Audio Pipeline Performance**: <assessment>
- **FFI Safety (unsafe Rust)**: <assessment>
- **Build Time Impact**: <assessment>
- **App Size Impact**: <assessment>
- **Notarization Compatibility**: <assessment>

### Reversibility
**Classification**: <Easily Reversible / Reversible with Effort / Partially Reversible / Irreversible>
**Rollback plan**: <description>
**Estimated rollback time**: <duration>

### Risk Summary
- **Critical risks**: <count> — <summary>
- **High risks**: <count> — <summary>
- **Mitigatable risks**: <count>
- **Accepted risks**: <count>

---

## 5. Migration Strategy

### Recommended Approach
**<Big Bang / Incremental / Parallel Run>**
<Rationale for chosen approach>

### Phase Breakdown
| Phase | Scope | Rollback Plan |
|-------|-------|---------------|
| 1 | <scope> | <rollback> |
| 2 | <scope> | <rollback> |

---

## 6. Metrics & Observability

### Baseline (Before)
| Metric | Current Value |
|--------|--------------|
| <metric> | <value or TBD> |

### During Migration
| Signal | Threshold | Action if Breached |
|--------|-----------|-------------------|
| <signal> | <threshold> | <action> |

### Convergence (After)
| Metric | Target | Measurement Period |
|--------|--------|-------------------|
| <metric> | <target> | <period> |

---

## 7. Test Strategy

### Automated Tests
| Type | What | Priority | New? |
|------|------|----------|------|
| <type> | <what> | P1/P2 | Yes/No |

### Manual Test Cases
| ID | Scenario | Priority |
|----|----------|----------|
| MT1 | <scenario> | P1/P2/P3 |

### Platform Testing
<How to validate across macOS versions and hardware configurations>

---

## 8. Verdict

### Recommendation: <GO / NO-GO / CONDITIONAL GO>

### Reasoning
<3-5 bullet points explaining the recommendation>

### If GO:
- **Estimated effort**: <size>
- **Recommended approach**: <approach>
- **First step**: <what to do first>
- **Critical prerequisites**: <what must be true before starting>
- **Build verification**: `yarn build` and `cargo check --features local-stt`

### If NO-GO:
- **Primary blockers**: <what makes this inadvisable>
- **Alternative approaches**: <what to do instead>
- **Revisit conditions**: <under what conditions should we reconsider>

### If CONDITIONAL GO:
- **Conditions that must be met**: <list>
- **Reduced scope recommendation**: <what to do if full scope is too risky>

---

## 9. References
- <Link to official docs>
- <Link to relevant blog posts>
- <Link to benchmarks>
- <Link to codebase files>

---
*Evaluated by [`/evaluate`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/evaluate/SKILL.md)*
```

---

## Phase 9: HUMAN VERIFICATION (Gate)

**This is the mandatory decision gate. The entire point of the skill.**

### 9.1 Present Summary

Display the evaluation summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EVALUATION COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Proposal:    <1-line summary>
Verdict:     <GO / NO-GO / CONDITIONAL GO>

Blast Radius:
  CRITICAL:  <N> files
  HIGH:      <N> files
  MEDIUM:    <N> files
  Total:     <N> files affected

Risks:
  Critical:  <N> risks
  High:      <N> risks
  Mitigated: <N> risks

Linty-Specific Concerns:
  macOS compat:   <OK / CONCERN>
  Entitlements:   <OK / CONCERN>
  Audio latency:  <OK / CONCERN>
  FFI safety:     <OK / CONCERN>
  Build time:     <OK / CONCERN>
  App size:       <OK / CONCERN>
  Notarization:   <OK / CONCERN>

Feature Gaps: <N> gaps found
Reversibility: <classification>

Key Findings:
  + <pro 1>
  + <pro 2>
  - <con 1>
  - <con 2>
  ! <warning 1>

Recommended Approach: <approach>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 9.2 Get Decision

Use `AskUserQuestion`:

**"Based on this evaluation, how would you like to proceed?"**
- **"Go — start building"** -> Chain into `/build` with the evaluation context
- **"Go — but I want to modify the scope first"** -> Gather modifications, re-assess
- **"No-go — not worth it"** -> Close evaluation, document the decision
- **"I need more information on specific areas"** -> Ask what areas, do targeted research

### 9.3 Handle Each Decision

**If "Go — start building":**
1. Mark the verdict as **GO**
2. Invoke the `/build` skill with the evaluation context
3. Pass key constraints (macOS compatibility, entitlement requirements, performance budgets)

**If "Go — modify scope":**
1. Gather the user's modifications via `AskUserQuestion`
2. Re-assess affected sections (blast radius, risks, metrics)
3. Re-present the summary (loop back to 9.1)

**If "No-go":**
1. Mark the verdict as **NO-GO**
2. Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  EVALUATION: NO-GO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Alternative approaches suggested above.
This evaluation can be revisited when conditions change.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Skill: /evaluate
File:  .claude/skills/evaluate/SKILL.md
```

**If "Need more information":**
1. Ask what specific areas need deeper investigation
2. Run targeted research (web search, codebase analysis, or both)
3. Update the evaluation with new findings
4. Re-present the summary (loop back to 9.1)

---

## Phase 10: SELF-HEALING

**After every `/evaluate` execution**, run this phase to keep the skill accurate.

### 10.1 Evaluate Skill Accuracy

Re-read this skill file and compare its instructions against what actually happened during execution:

| Check | What to look for |
|-------|-----------------|
| **Web search** | Did `WebSearch` or `WebFetch` queries return useful results? Should query templates be updated? |
| **Codebase analysis** | Were the Grep/Glob patterns effective? Any new patterns needed for Linty's structure? |
| **Workflow logic** | Did any phase need to be skipped, reordered, or modified? |
| **Templates** | Are evaluation frameworks and report format still accurate? |
| **User interaction** | Were the AskUserQuestion prompts clear and useful? |
| **Linty-specific checks** | Were the macOS/entitlement/audio/FFI risk categories relevant and complete? |
| **Build commands** | Did `yarn build` and `cargo check --features local-stt` still work as documented? |

### 10.2 Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Keep changes minimal and targeted — fix only what's wrong
3. Log each fix:

```
Self-Healing Log:
- Fixed: <what was wrong> -> <what it was changed to>
- Reason: <why the original was inaccurate>
```

If nothing needs fixing, skip silently.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Web search returns no results | Note the gap, rely on codebase analysis and user knowledge |
| User provides vague proposal | Ask targeted clarifying questions before proceeding |
| Evaluation reveals the change is trivial | Inform user, suggest skipping evaluation and going straight to `/build` |
| User wants to evaluate multiple options | Run Phases 2-4 for each option, create comparison table |
| Research contradicts user's assumption | Present evidence neutrally, let user decide |
| Build commands fail during analysis | Document the failure, investigate if it's related to the proposed change |
| macOS-specific research is sparse | Note the gap, rely on Apple developer documentation and Tauri community |

---

## State Tracking

Throughout the entire workflow, maintain awareness of:
- **Current phase** (which phase we're in)
- **Research findings** (running list of all sources consulted)
- **Risk count by severity** (updated as new risks are discovered)
- **Linty-specific concerns** (macOS compat, entitlements, audio, FFI, build, size, notarization)
- **User decisions** (all AskUserQuestion responses)
- **Affected codebase areas** (src-tauri/src/, src/, scripts/, .github/workflows/)

---

## Tips

- **Be neutral**: Present evidence, not opinions. Let the data drive the recommendation.
- **Quantify when possible**: "7 files affected in src-tauri/src/" is better than "many files affected"
- **Show your work**: Link to sources, cite specific files, reference concrete data
- **Don't scare unnecessarily**: Every migration has risks — frame them with mitigations
- **Don't downplay real risks**: If something is genuinely dangerous (e.g., breaking notarization), say so clearly
- **Compare to alternatives**: "Don't do it" is incomplete — suggest what to do instead
- **Think about macOS specifics**: Entitlements, TCC, Metal GPU, Hardened Runtime are all potential landmines
- **Consider build impact**: whisper-rs already compiles slowly — will this make it worse or better?
- **Consider app size**: Users download a DMG — how does this affect download size?
- **Consider timing**: Is now the right time, even if the change itself is good?
- **Blast radius over everything**: The size of what could go wrong matters more than the probability
- **Test from Finder, not Terminal**: Terminal launch bypasses entitlement checks — always validate from Finder/DMG
