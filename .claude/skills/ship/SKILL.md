---
name: ship
user-invocable: true
disable-model-invocation: false
description: Automates the complete shipping workflow after code changes are ready. Creates git branch, commits changes, and opens PR. Triggers on "ship this", "create PR", "commit and push", "ship it", "ready to merge", "create PR for this".
---

# Ship Workflow

Automates the full shipping process: branch setup, commit, push, and PR creation.

## When to Use

Run `/ship` after you've completed code changes and are ready to:
- Commit your changes with proper formatting
- Push to remote
- Open a PR for review

## Workflow Steps

Execute these steps IN ORDER. Do not skip steps.

---

### Step 1: Analyze Changes

First, understand what was changed:

```bash
# Check current branch and status
git status

# See the diff of changes (staged and unstaged)
git diff
git diff --cached

# Check current branch name
git branch --show-current

# Recent commit history for context
git log --oneline -5
```

From the conversation context and git diff, identify:
- **What changed**: Files modified, features added/fixed
- **Why it changed**: The problem being solved
- **Type of change**: feat, fix, refactor, docs, chore, test
- **Scope**: Which area affected (frontend, rust, audio, transcribe, macos, clipboard, capsule, tauri, build, config)

---

### Step 2: Sync with Main

Always sync with the latest changes from origin/main before proceeding:

```bash
# Fetch latest changes from origin
git fetch origin main

# If on a feature branch, rebase onto main
git rebase origin/main
```

**If rebase conflicts occur**:
1. Resolve conflicts in affected files
2. Stage resolved files: `git add <files>`
3. Continue rebase: `git rebase --continue`
4. If too complex, abort and merge instead: `git rebase --abort && git merge origin/main`

**If branch already exists on remote**:
```bash
# Pull latest changes from the remote branch first
git pull --rebase origin {branch-name}
```

**If still on `main` with uncommitted work and `origin/main` moved ahead** (typical: CI version-bump commits), `git rebase` refuses a dirty tree — stash, fast-forward, re-apply:
```bash
git stash push -u -m ship && git merge --ff-only origin/main && git stash pop
```

---

### Step 3: Pre-Ship Checks

Before proceeding, verify the code is sound:

```bash
# Frontend build (includes TypeScript check)
cd <checkout-root> && yarn build

# Rust type check — both feature sets ship (release builds use local-stt,parakeet;
# the parakeet check also compiles the Swift bridge in src-tauri/swift/)
cd <checkout-root>/src-tauri && cargo check --features local-stt && cargo check --features local-stt,parakeet
```

If `cargo` is not on PATH (non-login shell), use the rustup toolchain directly:
`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`.

`<checkout-root>` is the main checkout or the worktree holding the change. A fresh worktree has no `node_modules`; when no frontend files changed, skip `yarn build` and say so in the PR test plan.

**Checklist**:
- [ ] Frontend build passes (`yarn build`)
- [ ] Rust compiles (`cargo check --features local-stt` and `--features local-stt,parakeet`)
- [ ] No console.log statements in changed files
- [ ] No hardcoded secrets (.env values, API keys)
- [ ] Changes are tested locally

**If build/typecheck fails**: Fix the issues before proceeding. Do NOT ship broken code.

**Website-only diffs**: If the diff only touches `website/` (static site, no build step), skip the Rust check and run `node --check website/main.js` instead of relying solely on `yarn build`.

---

### Step 4: Create Branch (if on main)

If currently on `main`, create a feature branch:

```bash
git checkout -b {username}/{short-description}
```

**Branch naming**: `{username}/{short-description}` (lowercase, kebab-case)
- Example: `hari/fix-audio-capture-silence`
- Example: `hari/add-groq-fallback`

Get username from git config:
```bash
git config user.name | tr '[:upper:]' '[:lower:]' | tr ' ' '-'
```

**If already on a feature branch**: Stay on it. Do not create a new branch.

---

### Step 5: Commit Changes

Stage and commit with conventional commit format.

**CRITICAL -- Working Directory**: Always use absolute paths or run git commands from the root of the checkout being shipped. That is `/Users/hari/2026/linty`, or the worktree root (e.g. `/Users/hari/2026/linty/.claude/worktrees/<name>`) when the work lives in a worktree; running git in the main checkout would commit to whatever branch it has checked out. After running build/typecheck commands, the shell CWD may have changed, causing `git add` with relative paths to fail.

```bash
git add <files>
git commit -m "$(cat <<'EOF'
type(scope): short description

Longer description if needed.

{attribution lines from the current session's guidance, e.g. Co-Authored-By + Claude-Session}
EOF
)"
```

**Commit types**:
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code restructuring
- `docs`: Documentation
- `chore`: Maintenance
- `test`: Tests

**Scope**: The area affected:
- `frontend` -- React UI changes
- `rust` -- General Rust backend changes
- `audio` -- cpal audio capture
- `transcribe` -- whisper-rs or Groq transcription
- `macos` -- macOS FFI (permissions, fn key, NSPanel)
- `clipboard` -- NSPasteboard snapshot/restore
- `capsule` -- Overlay panel
- `tauri` -- Tauri config, commands, plugins
- `build` -- Build scripts, CI, notarization
- `config` -- App configuration, settings

---

### Step 6: Push Branch

```bash
git push -u origin {branch-name}
```

---

### Step 7: Create PR

Use GitHub CLI to create the PR:

```bash
gh pr create --title "type(scope): description" --body "$(cat <<'EOF'
## Summary
- Bullet points of what changed

## Root Cause (for fixes)
Explain why the issue occurred (omit this section for features)

## Impact
- What's affected by this change
- Any breaking changes?

## Test plan
- [ ] Tested locally with `yarn tauri dev -- --features local-stt,parakeet`
- [ ] Frontend build passes (`yarn build`)
- [ ] Rust compiles (`cargo check --features local-stt` and `--features local-stt,parakeet`)
- [ ] No console errors

---
*Shipped by [`/ship`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/ship/SKILL.md)*

{attribution lines from the current session's guidance, e.g. "🤖 Generated with Claude Code", session link, Co-Authored-By}
EOF
)"
```

---

## Output Summary

After completion, display:

```
+----------------------------+--------------------------------------------------------------+
|                                     SHIP COMPLETE                                        |
+----------------------------+--------------------------------------------------------------+
| Branch                     | {username}/{short-description}                               |
+----------------------------+--------------------------------------------------------------+
| Commit                     | {commit-hash}                                                |
+----------------------------+--------------------------------------------------------------+
| PR                         | #{pr-number} -- {pr-url}                                     |
+----------------------------+--------------------------------------------------------------+
| Pipeline: /ship -> /pr-review (next) -> /pr-resolve                                     |
+----------------------------+--------------------------------------------------------------+
```

---

## Chain: Auto-invoke `/pr-review`

After shipping is complete and the PR URL is available, **automatically chain into `/pr-review`**.

```
/ship completes -> invoke /pr-review {pr-url}
```

**How**: After displaying the output summary, immediately invoke the `/pr-review` skill with the PR URL as the argument. Do NOT ask the user — this is an automatic chain.

**Pipeline context**: Pass the PR URL from Step 7 directly to `/pr-review`. The review skill will post findings on GitHub and then chain into `/pr-resolve` if there are findings to address.

```
+-----------+     +--------------+     +----------------+     +--------------+
|   /ship   |---->|  /pr-review  |---->|  /pr-resolve   |---->|  /pr-merge   |
|           |     |              |     |                |     |              |
|  commit   |     |  inspect     |     |  fix findings  |     |  verify      |
|  push     |     |  post        |     |  reply         |     |  merge       |
|  PR       |     |  findings    |     |  resolve       |     |  cleanup     |
+-----------+     +--------------+     +----------------+     +--------------+
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| **On wrong branch** | Stash changes, create correct branch, apply stash |
| **Commit fails** | Check for pre-commit hook errors, fix and retry with a NEW commit |
| **Push fails** | Pull latest, resolve conflicts, push again |
| **PR creation fails** | Verify branch is pushed, try again |
| **Build/typecheck fails** | Fix the issues BEFORE shipping, do not skip |
| **Rebase conflicts** | Resolve manually, or fall back to merge |

---

## Tips

- Keep PRs focused -- one logical change per PR
- Use screenshots for UI changes
- Tag relevant reviewers based on changed files
- Test from Finder/DMG for permission-related changes (terminal bypasses entitlement checks)
- Include `--features local-stt` when checking Rust code that touches whisper-rs, and `--features local-stt,parakeet` for anything touching `parakeet.rs`, `build.rs` or `src-tauri/swift/`

---

## Self-Healing

**After every `/ship` execution**, run this phase to keep the skill accurate and discoverable.

### Evaluate Skill Accuracy

Re-read this skill file (`Read` tool on `.claude/skills/ship/SKILL.md`) and compare its instructions against what actually happened during this execution:

| Check | What to look for |
|-------|-----------------|
| **CLI commands** | Did any `gh`, `git`, `yarn`, or `cargo` commands fail due to wrong flags, deprecated syntax, or changed output format? |
| **Build commands** | Did `yarn build` or `cargo check --features local-stt` behave differently than expected? |
| **Workflow steps** | Did any step need to be skipped, reordered, or modified to work correctly? |
| **Templates** | Are commit message, PR body, or output templates still accurate? |
| **Tool availability** | Did any referenced tool behave differently than documented? |

### Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Keep changes minimal and targeted -- fix only what's wrong
3. Log each fix:

```
Self-Healing Log:
- Fixed: <what was wrong> -> <what it was changed to>
- Reason: <why the original was inaccurate>
```

If nothing needs fixing, skip silently.

### Append Skill Attribution

After execution, ensure the skill attribution is present in:

**PR description** (add via `gh pr edit` if not already present):
```markdown
---
*Shipped by [`/ship`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/ship/SKILL.md) -- Triggers: "ship this", "create PR", "commit and push", "ship it", "ready to merge"*
```

**Output summary** displayed to the user:
```
Skill: /ship
File:  .claude/skills/ship/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/ship/SKILL.md
```
