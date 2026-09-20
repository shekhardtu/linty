---
name: backlog
user-invocable: true
disable-model-invocation: false
description: Capture feature ideas, tech debt, and bugs into a GitHub Issue backlog. Each entry includes codebase context for easy handoff to /build. Triggers on "backlog", "add to backlog", "track this", "backlog mark".
---

# Backlog Register

Lightweight skill to capture ideas into **GitHub Issues** on `shekhardtu/linty`. Each issue has enough codebase context that someone can copy-paste it into `/build` and start implementing.

---

## Triggers

- `/backlog <description>` — Add a new backlog entry
- `/backlog mark #NNN <status>` — Update an issue's status (close, reopen, label)
- Casual inline: `Implement noise cancellation /backlog` (description before the command)

---

## Phase 1: PARSE

Extract from the user's prompt:

| Field | How to determine |
|-------|-----------------|
| **Title** | Short imperative title from the description (e.g., "Add noise cancellation") |
| **Type** | `feature` (new capability), `tech-debt` (refactor/cleanup), `bug` (broken behavior). Default: `feature` |
| **Priority** | `P1` (critical), `P2` (important), `P3` (normal), `P4` (nice-to-have). Default: `P3` |

If the prompt is a **status update** (contains `mark #NNN`), skip to Phase 4b instead.

---

## Phase 2: RESEARCH

Quick codebase scan — 3-5 tool calls max. Do NOT over-research; this is a backlog capture, not a full `/build` investigation.

### 2.1 Find Related Files

```
Grep for keywords from the title/description.
Glob for likely file patterns (components, hooks, Rust modules).
```

### 2.2 Check for Existing Work

```
Grep for TODOs, FIXMEs, or existing partial implementations related to this idea.
```

### 2.3 Identify Affected Layers

Determine which layers are affected:
- `src/` — React frontend (pages, components, hooks, services, store)
- `src-tauri/src/` — Rust backend (audio, transcribe, fnkey, permissions, clipboard, paste, capsule, watchdog)
- `src-tauri/` — Tauri config, Cargo.toml, entitlements
- `.github/` — CI/CD workflow
- `scripts/` — Build scripts

### 2.4 Estimate Complexity

| Size | Criteria |
|------|----------|
| XS | 1 file, minor change |
| S | 1-2 files, follows existing pattern |
| M | 2-4 files, new component but known patterns |
| L | 4-8 files, new pattern or cross-cutting |
| XL | 8+ files, architectural change |

---

## Phase 3: ANALYZE

From research, compile:

- **Key files**: Up to 5-8 most relevant files with path, purpose, and action (Create/Modify)
- **Blast radius**: Which systems/layers are touched
- **Risks**: 1-3 bullets on what could go wrong or get complicated
- **Implementation hints**: 2-4 bullets with enough context for `/build` to start (existing patterns to follow, APIs to use, components to extend)
- **Related code**: Existing TODOs, partial implementations, related features

---

## Phase 4a: DOCUMENT (New Entry)

### 4.1 Create GitHub Issue

```bash
gh issue create --repo shekhardtu/linty \
  --title "<title>" \
  --label "<type>,<priority>" \
  --body "$(cat <<'EOF'
## Description
<Expanded description — 2-4 sentences with enough context to understand the ask>

## Metadata
- **Type**: <feature/tech-debt/bug>
- **Priority**: <P1-P4>
- **Complexity**: <XS-XL>

## Affected Layers
- <Frontend / Rust backend / Tauri config / CI>

## Key Files
| File | Purpose | Action |
|------|---------|--------|
| `path/to/file` | What this file does | Create/Modify |

## Blast Radius
<1-2 sentences on what systems/layers are touched>

## Risks
- <Risk 1>
- <Risk 2>

## Related Code
- <Existing pattern, TODO, or dependency worth noting>

## Implementation Hints
- <Hint 1: enough for /build to start>
- <Hint 2>
EOF
)"
```

### 4.2 Create Labels (if needed)

Ensure these labels exist on the repo:
```bash
gh label create "feature" --color "0E8A16" --repo shekhardtu/linty 2>/dev/null || true
gh label create "tech-debt" --color "FBCA04" --repo shekhardtu/linty 2>/dev/null || true
gh label create "bug" --color "D73A4A" --repo shekhardtu/linty 2>/dev/null || true
gh label create "P1" --color "B60205" --repo shekhardtu/linty 2>/dev/null || true
gh label create "P2" --color "FF9F1C" --repo shekhardtu/linty 2>/dev/null || true
gh label create "P3" --color "0075CA" --repo shekhardtu/linty 2>/dev/null || true
gh label create "P4" --color "CFD3D7" --repo shekhardtu/linty 2>/dev/null || true
```

---

## Phase 4b: STATUS UPDATE

When the prompt contains `mark #NNN <status>`:

1. Fetch the issue: `gh issue view NNN --repo shekhardtu/linty`
2. Update based on status:
   - `done` → `gh issue close NNN --repo shekhardtu/linty`
   - `in-progress` → `gh issue edit NNN --add-label "in-progress" --repo shekhardtu/linty`
   - `cancelled` → `gh issue close NNN --reason "not planned" --repo shekhardtu/linty`
   - `open` → `gh issue reopen NNN --repo shekhardtu/linty`
3. Display confirmation

---

## Phase 5: OUTPUT

### New Entry Confirmation

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BACKLOG ENTRY ADDED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issue:      #NNN
Title:      <Title>
Type:       <feature/tech-debt/bug>
Priority:   <P1-P4>
Complexity: <XS-XL>
Files:      <N> key files identified

URL: https://github.com/shekhardtu/linty/issues/NNN

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tip: Run `/build <Title>` to start implementing this entry.

Skill: /backlog
File:  .claude/skills/backlog/SKILL.md
```

### Status Update Confirmation

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BACKLOG UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issue:  #NNN — <Title>
Status: <old status> → <new status>

URL: https://github.com/shekhardtu/linty/issues/NNN

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Skill: /backlog
File:  .claude/skills/backlog/SKILL.md
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| GitHub API fails | Retry once, then inform user |
| Issue not found for status update | List recent issues, ask user to confirm |
| Duplicate title detected | Warn user, still create (different issue numbers) |

---

## Tips

- Keep entries concise — this is a backlog, not a design doc
- If research reveals the idea is trivial (XS), suggest just doing it now instead of backlogging
- If research reveals the idea is massive (XL+), suggest breaking it into multiple issues
