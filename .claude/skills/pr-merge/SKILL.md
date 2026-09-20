---
name: pr-merge
user-invocable: true
disable-model-invocation: false
description: "Safely merge a PR after all checks pass. Verifies CI status, unresolved threads, and approval state before merging. Final step in the /ship -> /pr-review -> /pr-resolve -> /pr-merge pipeline. Triggers on: \"merge PR\", \"merge this\", \"merge it\", \"ready to merge\", \"/pr-merge\"."
---

# PR Merge — Safe Pull Request Merge

Safely merges a PR after verifying all pre-merge conditions are met. This is the **final step** in the shipping pipeline.

```
┌─────────┐     ┌────────────┐     ┌──────────────┐     ┌────────────┐
│  /ship   │────▶│ /pr-review │────▶│ /pr-resolve  │────▶│ /pr-merge  │
│          │     │            │     │              │     │            │
│ commit   │     │ inspect    │     │ fix findings │     │ verify     │
│ push     │     │ post       │     │ reply        │     │ merge      │
│ PR       │     │ findings   │     │ resolve      │     │ cleanup    │
└─────────┘     └────────────┘     └──────────────┘     └────────────┘
                                                         ▲ YOU ARE HERE
```

## When to Use

Run `/pr-merge` when:
- All review comments have been resolved
- CI checks are passing
- The PR is ready to merge into main
- **Auto-invoked** by `/pr-resolve` after all threads are resolved

**Input**: PR number or URL (e.g., `18` or `https://github.com/shekhardtu/linty/pull/18`)

---

## Phase 1: Pre-Merge Verification

### 1.1 Authentication Check
```bash
gh auth status
```
If not authenticated, stop and instruct: `gh auth login`.

### 1.2 Fetch PR State
```bash
gh pr view <PR_NUMBER> --repo shekhardtu/linty --json number,title,headRefName,baseRefName,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,url,body
```

### 1.3 Verify Merge Conditions

Run through ALL checks before proceeding. **All must pass.**

| Check | Command | Pass Criteria | Block on Fail? |
|-------|---------|---------------|----------------|
| **PR is open** | `state` field | `OPEN` | Yes — cannot merge closed/merged PR |
| **Mergeable** | `mergeable` field | `MERGEABLE` | Yes — resolve conflicts first |
| **CI checks** | `statusCheckRollup` | All `SUCCESS` or `NEUTRAL` | Yes — wait for CI |
| **No unresolved threads** | See 1.4 below | 0 unresolved threads | Yes — resolve threads first |
| **Branch up to date** | `mergeStateStatus` | `CLEAN` or `HAS_HOOKS` | Warn — suggest rebase |

### 1.4 Check Unresolved Threads

**CRITICAL**: `gh api graphql` can fail with `Expected VAR_SIGN` errors when using `-f varName=value` for GraphQL variables. Always inline values directly in the query string:

```bash
gh api graphql -f query='
{
  repository(owner: "shekhardtu", name: "linty") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          isResolved
          isOutdated
          comments(first: 1) {
            nodes { body path line }
          }
        }
      }
    }
  }
}'
```

If `hasNextPage` is true, re-run the query with `after: "CURSOR_VALUE"` added to `reviewThreads(first: 100, after: "...")`. Repeat until all pages are fetched.

Count threads where `isResolved: false` and `isOutdated: false`. If any exist, list them and **block merge**.

### 1.5 Check CI Status

```bash
gh pr checks <PR_NUMBER> --repo shekhardtu/linty
```

If any checks are still running, wait and re-check (up to 2 retries with 30s between). If checks fail, **block merge** and report which checks failed.

**Note**: Pull requests run `.github/workflows/checks.yml` (Node tests and Rust logging hygiene); wait for those checks to pass. `Build macOS DMG` runs after a push to `main`. A missing PR check is not a passing check: inspect the current workflow triggers and run status. After merging, verify the release workflow started on `main` (`gh run list --branch main`).

---

## Phase 2: Merge Decision

### 2.1 Pre-Merge Summary

Display to the user before merging:

```
┌──────────────────────────────────────────────────┐
│              PRE-MERGE CHECKLIST                  │
├──────────────────────────────────────────────────┤
│ PR:              #{number} — {title}             │
│ Branch:          {head} → {base}                 │
│ Mergeable:       Pass / Fail                     │
│ CI Checks:       All passing / {N} failing       │
│ Unresolved:      0 threads / {N} threads         │
│ Review Decision: APPROVED / CHANGES_REQUESTED    │
│ Branch Status:   CLEAN / BEHIND                  │
├──────────────────────────────────────────────────┤
│ Verdict:         READY TO MERGE / BLOCKED        │
└──────────────────────────────────────────────────┘
```

### 2.2 Block Conditions

If ANY of these are true, **do NOT merge** — report what's blocking:

- PR is not open
- PR is not mergeable (conflicts)
- CI checks failing
- Unresolved non-outdated review threads exist

### 2.3 Warn Conditions

These produce a warning but do NOT block:

- Branch is behind base (suggest rebase)
- No explicit approval (COMMENT reviews only)
- Draft PR

---

## Phase 3: Execute Merge

### 3.1 Merge the PR

Use squash merge (default for this repo) to keep history clean:

```bash
gh pr merge <PR_NUMBER> --repo shekhardtu/linty --squash --delete-branch
```

**Merge strategy**: `--squash` combines all commits into one clean commit on main.
**Branch cleanup**: `--delete-branch` removes the feature branch after merge.

### 3.2 If Merge Fails

| Error | Action |
|-------|--------|
| Merge conflicts | Report — suggest `git rebase origin/main` and re-push |
| Required reviews missing | Report — suggest requesting review |
| Branch protection rules | Report — list which rules are blocking |
| CI still running | Wait 30s, retry once |

---

## Phase 4: Post-Merge

### 4.1 Verify Merge

```bash
gh pr view <PR_NUMBER> --repo shekhardtu/linty --json state,mergedAt,mergeCommit
```

Confirm `state: MERGED`.

### 4.2 Update Local Repository

```bash
git checkout main
git pull origin main
```

---

## Phase 5: Output

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                   MERGE COMPLETE                                                       │
├──────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PR           │ #{number} — {title}                                                                                    │
├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Merged       │ {head} → {base}                                                                                        │
├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Commit       │ {merge-commit-sha}                                                                                     │
├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Branch       │ {head} — deleted                                                                                       │
├──────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Pipeline Complete                                                                                                      │
│  /ship -> /pr-review -> /pr-resolve -> /pr-merge                                                                      │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Post-Merge                                                                                                             │
│  1. Monitor CI build-dmg workflow                                                                                      │
│  2. Verify GitHub Release created                                                                                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Skill: /pr-merge
File:  .claude/skills/pr-merge/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/pr-merge/SKILL.md
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| **PR already merged** | Report — show merge details, skip |
| **PR closed (not merged)** | Report — cannot merge a closed PR |
| **Merge conflicts** | Block — suggest rebase, do NOT force merge |
| **CI failing** | Block — list failing checks |
| **Unresolved threads** | Block — list unresolved threads with file/line |
| **No approval** | Warn — proceed if no branch protection requires it |
| **gh CLI error** | Retry once, then report |

---

## Self-Healing

**After every `/pr-merge` execution**, run this phase.

### Evaluate Accuracy

| Check | What to look for |
|-------|-----------------|
| **gh pr merge flags** | Did `--squash --delete-branch` work? Any new required flags? |
| **GraphQL queries** | Did the unresolved threads query work? Field names correct? |
| **CI check format** | Did `gh pr checks` output match expectations? |
| **Post-merge steps** | Did local checkout/pull work? |

### Fix Issues Found

If any discrepancies:
1. Use `Edit` tool to fix this skill file
2. Log:
```
Self-Healing Log:
- Fixed: <what> -> <what>
- Reason: <why>
```

---

## Guidelines

- **NEVER force merge** — if there are conflicts, blocks, or failures, report and stop
- **NEVER skip CI checks** — even if user asks, warn about risks
- **ALWAYS verify merge succeeded** — check the state after merging
- **Squash merge is default** — keeps main branch history clean
- **Delete branch after merge** — prevents stale branch accumulation
