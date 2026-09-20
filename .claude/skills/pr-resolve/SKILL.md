---
name: pr-resolve
user-invocable: true
disable-model-invocation: false
description: "Resolve PR review comments, check for issues, commit fixes and push. Critical PR resolution skill that resolves reviewer comments, performs proactive code quality analysis, validates builds, replies to threads, and marks them resolved on GitHub. Triggers on: \"resolve PR\", \"fix PR comments\", \"address PR feedback\", \"resolve PR comments\", \"/pr-resolve\"."
---

# PR Resolve — Critical Pull Request Resolution & Review

Resolves reviewer comments **and** performs proactive code quality analysis, build validation, threaded replies, and re-review requests. Adapted for the Linty desktop app (Tauri v2 + React 19 + Rust).

**Pipeline position**: This is the final step in the `/ship` -> `/pr-review` -> `/pr-resolve` chain.

```
┌─────────┐     ┌────────────┐     ┌──────────────┐     ┌────────────┐
│  /ship   │────▶│ /pr-review │────▶│ /pr-resolve  │────▶│ /pr-merge  │
│          │     │            │     │              │     │            │
│ commit   │     │ inspect    │     │ fix findings │     │ verify     │
│ push     │     │ post       │     │ reply        │     │ merge      │
│ PR       │     │ findings   │     │ resolve      │     │ cleanup    │
└─────────┘     └────────────┘     └──────────────┘     └────────────┘
                                    ▲ YOU ARE HERE        (next)
```

## When to Use

Run `/pr-resolve` when:
- You receive review comments on a PR and need to address them
- You want a comprehensive code quality check on an open PR
- You need to resolve, reply, and re-request review in one pass
- **Auto-invoked** by `/pr-review` when findings are posted

**Input**: A GitHub PR URL (e.g., `https://github.com/shekhardtu/linty/pull/18`)

---

## Phase 1: PR Analysis & Setup

### 1.1 Authentication Check
```bash
gh auth status
```
If not authenticated, stop and instruct: `gh auth login`.

### 1.2 Extract PR Metadata
```bash
# Full PR metadata
gh pr view <PR_NUMBER> --json number,title,headRefName,baseRefName,author,reviewRequests,labels,state,url,body

# PR diff
gh pr diff <PR_NUMBER>

# Checkout PR branch
gh pr checkout <PR_NUMBER>
```

### 1.3 Fetch All Comments & Reviews
```bash
# Review comments (inline code comments)
gh api repos/shekhardtu/linty/pulls/{pr_number}/comments --paginate

# Issue comments (general PR comments)
gh api repos/shekhardtu/linty/issues/{pr_number}/comments --paginate

# Reviews with their states (APPROVED, CHANGES_REQUESTED, COMMENTED)
gh api repos/shekhardtu/linty/pulls/{pr_number}/reviews --paginate
```

### 1.4 Fetch Review Threads (for later resolution)
```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 10) {
              nodes {
                id
                body
                path
                line
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  }
' -f owner='shekhardtu' -f repo='linty' -F pr=PR_NUMBER
```

Save thread IDs mapped to file paths and line numbers for Phase 8.

---

## Phase 1B: Load Repository & App-Level Context

Before reviewing any comments, load the project-specific coding standards and architectural context. These files contain **critical rules** that reviewers enforce — understanding them prevents incorrect fixes and ensures compliance.

### 1B.1 Determine Affected Areas

From the PR diff file list (Phase 1.2), identify which areas are touched:
```bash
gh pr diff <PR_NUMBER> --name-only
```

Map changed file paths to their area:
| Path prefix | Area |
|-------------|------|
| `src/` | React frontend (pages, components, hooks, store, services) |
| `src-tauri/src/` | Rust backend (audio, transcription, permissions, clipboard, paste, fnkey) |
| `src-tauri/` | Tauri config (tauri.conf.json, Cargo.toml, Entitlements.plist, Info.plist) |
| `.github/` | CI/CD (build-dmg workflow, actions) |
| Root-level files | Project config (package.json, tsconfig, vite.config) |

### 1B.2 Read Instruction Files

**Always read** (these apply to all PRs):
1. **Root `CLAUDE.md`** — Project-wide coding standards, architecture overview, build commands, entitlement rules, zero-copy audio design, activation policy rules

### 1B.3 Extract Review-Critical Rules

From the loaded instruction files, extract and keep in mind:

**Naming & File Conventions:**
- File naming: `ComponentName.component.tsx`, `DialogName.dialogue.tsx`, `auth.store.ts`, `useAuth.hook.ts`, `user.service.ts`, `user.types.ts`, `PageName.page.tsx`, `LayoutName.layout.tsx`, `ContainerName.container.tsx`, `ContextName.context.tsx`
- Dialogues: Modal/dialog/popup components MUST use `.dialogue.tsx` (not `.modal.tsx`, `.popup.tsx`, or `.dialog.tsx`)
- Imports: External libs -> internal packages -> relative imports
- Naming: `camelCase` functions, `PascalCase` components, `UPPER_SNAKE` constants
- ID fields: Must include collection name prefix (`userId` not `id`, `orgId` not `id`)

**Architecture-Specific Rules:**
- **Rust backend**: Zero-copy audio (samples stay in Rust, never cross IPC). `Arc<Mutex<>>` for shared state. Feature-gated `local-stt` for whisper-rs/Metal. macOS FFI over plugins for permissions, fn key, clipboard. Proper entitlement keys for Hardened Runtime (NOT App Sandbox).
- **React frontend**: Zustand store split into slices. React 19 patterns. shadcn/ui components. Tailwind for styling.
- **Tauri config**: Two windows (main + capsule overlay). Programmatic activation policy (NOT `LSUIElement` in Info.plist). Hardened Runtime entitlements.

### 1B.4 Use Context During Review

Apply these loaded rules when:
- **Classifying comments** (Phase 2) — A comment about import order or file naming is valid per CLAUDE.md rules
- **Implementing fixes** (Phase 3) — Follow the exact naming convention, import order, and architecture patterns
- **Proactive scanning** (Phase 4) — Check changed files against ALL rules, not just the code quality checklist
- **Replying to threads** (Phase 7) — Reference specific rules when explaining fixes (e.g., "Fixed per CLAUDE.md naming convention: `DialogName.dialogue.tsx`")

---

## Phase 2: Comment Evaluation & Triage

For **each** review comment/thread, verify the claim against the actual code before classifying:

### 2.1 Locate & Read
1. Find the exact file and line(s) referenced
2. Read the **full file** (not just the snippet) to understand context
3. Read surrounding functions/components to understand dependencies

### 2.2 Verify Against Code

Before classifying, verify the reviewer's claim with evidence:

1. **Read the referenced code in full context** — Read the entire function/component the comment targets, not just the highlighted line. Understand the surrounding logic, imports, and call sites.
2. **Check if the issue actually exists** — Trace the execution path. If the reviewer says "missing error handling", check if it's handled upstream, in middleware, or in a wrapper. If they say "unused variable", check all references.
3. **Check against CLAUDE.md conventions** — Does the reviewer's suggestion align with project rules (file naming, import order, ID naming, architecture patterns)? If the suggestion contradicts CLAUDE.md, flag it.
4. **Check if already addressed** — Run `git log --oneline -- <file>` to see if a subsequent commit already fixed this. Check the current code state vs the diff the reviewer commented on.
5. **Research if needed** — If the comment references a library API, best practice, or pattern you're unsure about, use web search to verify the claim before accepting or rejecting it.

### 2.3 Classify with Confidence

Based on verification evidence from 2.2, assign a status **and** a confidence level:

**Statuses:**

| Status | Meaning | Confidence Required | Auto-resolve? | Reply? |
|--------|---------|---------------------|---------------|--------|
| **RESOLVED** | Will fix with code changes | Medium+ | Yes | Yes — describe what was changed |
| **ALREADY FIXED** | Current code already satisfies | High | Yes | Yes — cite the code/commit proving it |
| **NOT APPLICABLE** | Based on misunderstanding or outdated context | High | **No** | Yes — explain with code evidence |
| **NEEDS CLARIFICATION** | Ambiguous or can't verify with confidence | Any | **No** | Yes — ask a specific question citing what you found |
| **DEFERRED** | Valid but purely cosmetic/stylistic with no correctness impact | Medium+ | **No** | Yes — acknowledge and explain scope boundary |
| **DISAGREE** | Technically incorrect or would degrade code quality | High | **No** | Yes — provide code evidence and reasoning |

**Confidence Levels:**

| Confidence | Score | Criteria |
|------------|-------|----------|
| **High** | 90%+ | Verified against code — issue is clearly present, or clearly already fixed. You can point to specific lines/commits as proof. |
| **Medium** | 60-90% | Likely valid but can't fully verify (e.g., runtime behavior, edge case, depends on external state). |
| **Low** | <60% | Comment appears incorrect, outdated, or contradicts codebase conventions — but you're not certain. |

**Decision Matrix:**

| Confidence | Comment Valid? | Action |
|------------|---------------|--------|
| High + Valid | Yes | **RESOLVED** — implement fix |
| High + Invalid | No | **NOT APPLICABLE** or **DISAGREE** — explain with code evidence |
| High + Already done | N/A | **ALREADY FIXED** — cite the code or commit |
| Medium + Valid | Likely | **RESOLVED** — implement, note uncertainty in reply |
| Medium + Unclear | Maybe | **NEEDS CLARIFICATION** — ask specific question citing what you found |
| Low + Seems wrong | Probably not | **DISAGREE** — provide code evidence showing why |
| Low + Uncertain | Unknown | **NEEDS CLARIFICATION** — don't implement blindly |

**Key rule: Never implement a Low-confidence comment without clarification.**

### 2.3.1 Pre-Existing Issues — Fix, Don't Dismiss

**CRITICAL**: If a reviewer surfaces a **real, verified issue** — even if it existed before this PR — **fix it**. Do NOT classify it as NOT APPLICABLE or DEFERRED just because it's pre-existing. The reviewer took the time to identify it, it's real, and the PR is the right place to resolve it.

**When to fix pre-existing issues:**
- Security vulnerabilities (XSS, entitlement gaps, permission bypass) — **always fix**
- Correctness bugs (wrong behavior, data corruption) — **always fix**
- Type safety gaps (`any` types, missing validation) — **fix if in affected files**
- Performance issues (allocations in audio callback, unnecessary IPC) — **fix if in affected files**

**When to genuinely defer:**
- Purely cosmetic suggestions (rename a variable, reorder imports) in unrelated files
- Large-scope refactors that would expand the PR beyond its intent
- Issues in files not touched by this PR and unrelated to its scope

**The principle**: A PR review is a quality gate for the codebase, not just for the diff. If an issue is surfaced and can be fixed without derailing the PR, fix it.

### 2.4 Priority Ordering
Address comments in this order:
1. **Security/correctness** issues (highest priority)
2. **Bug-introducing** feedback
3. **Type safety** issues (`any`, missing types)
4. **Logic/behavior** changes
5. **Naming/style** suggestions
6. **Nice-to-haves** and suggestions

### 2.5 Document Reasoning
For every comment, record:
- The reviewer's intent (what they're asking for)
- Your verification findings (what the code actually does)
- Confidence level and justification (High/Medium/Low — why?)
- Classification and planned action (fix, skip, clarify)
- Evidence (specific code references, commit hashes, or convention rules supporting your decision)

---

## Phase 3: Implementation

For each comment classified as **RESOLVED**:

### 3.1 Implement the Fix
1. Understand the reviewer's intent — not just the literal ask
2. Plan the **minimal** change needed
3. Follow existing code patterns in the file
4. Use existing utilities, components, and types from the codebase

### 3.2 Commit Strategy
- **One commit per logical group** of related comments (not one per comment)
- Commit message format:
  ```
  fix(scope): address PR review — brief description

  - Comment by @reviewer: what was changed
  - Comment by @reviewer: what was changed

  Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
  ```
- Stage only the files you changed: `git add <specific-files>` (never `git add .`)

### 3.3 What NOT to Do
- Do NOT refactor code beyond what the comment asks
- Do NOT add new features or "improvements" not requested
- Do NOT change formatting of untouched lines
- Do NOT modify files that aren't related to any comment
- Do NOT add comments/docstrings the reviewer didn't ask for

---

## Phase 4: Proactive Code Quality Scan

After addressing all reviewer comments, perform an **independent** quality scan on the PR diff. This catches issues reviewers may have missed.

### 4.1 Scan the PR Diff
```bash
# Get list of changed files
gh pr diff <PR_NUMBER> --name-only

# Get the full diff
gh pr diff <PR_NUMBER>
```

### 4.2 Check Against Linty Code Standards

Run through these checks on **changed files only** (not the entire codebase). Use rules loaded in **Phase 1B** as the source of truth.

**Critical (must fix):**
- [ ] `console.log` statements left in code
- [ ] `any` type usage
- [ ] Hardcoded secrets, API keys, or `.env` values
- [ ] Missing error handling on async operations
- [ ] XSS vectors (`dangerouslySetInnerHTML` without sanitization)

**High (should fix):**
- [ ] `.unwrap()` in new Rust code (use `?` or proper error handling)
- [ ] `unsafe` block without safety comment explaining why it's sound
- [ ] Mutex scope issues (held across await points or longer than necessary)
- [ ] Missing `#[cfg(feature = "local-stt")]` feature gate on whisper/Metal code
- [ ] Wrong entitlement key in `Entitlements.plist` (must use Hardened Runtime keys, not App Sandbox)
- [ ] Allocations in audio callback (real-time thread must not allocate)
- [ ] Large data crossing IPC boundary (should use zero-copy pattern)

**Naming & Convention violations (from CLAUDE.md — Phase 1B):**
- [ ] File names not matching convention (`ComponentName.component.tsx`, `DialogName.dialogue.tsx`, `name.store.ts`, `useName.hook.ts`, `name.service.ts`, `name.types.ts`, `PageName.page.tsx`)
- [ ] Import order wrong (should be: external libs -> internal packages -> relative imports)
- [ ] Modal/dialog components not using `.dialogue.tsx` extension
- [ ] ID fields without collection prefix (`id` instead of `userId`, `orgId`, etc.)
- [ ] Generic names that don't reveal intent (`getData` instead of `getUserById`)

**Architecture violations (from app-level context — Phase 1B):**
- [ ] **src-tauri/src/**: Missing `Arc<Mutex<>>` for shared state across threads
- [ ] **src-tauri/src/**: Audio samples crossing IPC instead of staying in Rust
- [ ] **src-tauri/src/**: `LSUIElement` in Info.plist (should use programmatic activation policy)
- [ ] **src/**: Using Context API instead of Zustand stores for new state
- [ ] **src/**: Not using shadcn/ui components where available
- [ ] **src/**: Missing loading/error states on async operations

**Medium (suggest in comment):**
- [ ] Files exceeding 500 lines
- [ ] Missing props interface on components
- [ ] Missing TypeScript types (implicit `any` from inference)
- [ ] Commented-out code or TODO comments without ticket references
- [ ] Unused imports, variables, or functions (dead code)

### 4.3 Report Proactive Findings
If issues are found:
- **Critical/High**: Fix them, commit, and note in the report
- **Medium**: List them in the report for the author's awareness — do NOT auto-fix unless the reviewer explicitly asked

---

## Phase 5: Build & Type Validation

After all changes are committed, validate the build:

### 5.1 Frontend Build Check
```bash
yarn build
```

### 5.2 Rust Build Check
```bash
cd src-tauri && cargo check --features local-stt
cargo check --features local-stt,parakeet   # when parakeet.rs, build.rs, swift/ or parakeet-gated code changed
```

### 5.3 If Build Fails
1. Read the error output carefully
2. Fix errors — whether caused by your changes or pre-existing. The goal is a green build.
3. Commit the fix: `fix(scope): resolve build error from PR review changes`
4. Re-run the failing check to confirm

### 5.4 If Build Was Already Broken
Fix it if feasible within the PR scope. If the breakage is in a completely unrelated area, note it in the output and move on.

---

## Phase 6: Push Changes

```bash
git push origin <branch-name>
```

If push is rejected (remote has new commits):
```bash
git pull --rebase origin <branch-name>
# Resolve any conflicts
git push origin <branch-name>
```

---

## Phase 7: Reply to PR Comment Threads

After pushing, reply to **every** comment thread on the PR — not just the ones you fixed. This shows thoroughness and helps reviewers quickly re-review.

### 7.1 Reply Format by Status

**RESOLVED:**
```
Fixed in <commit-hash>. <1 sentence explaining the change>.
```

**ALREADY FIXED:**
```
This is already addressed — <explanation of why current code satisfies the comment>. Resolving.
```

**NOT APPLICABLE:**
```
After reviewing, I believe this doesn't apply here because <reasoning>. Happy to discuss if you see it differently.
```

**NEEDS CLARIFICATION:**
```
Could you clarify what you mean by <specific question>? I interpreted it as <your interpretation> but want to confirm before making changes.
```

**DEFERRED:**
```
Valid point. This is outside the scope of this PR — I've created a GitHub issue to track it.
```

**DISAGREE:**
```
I considered this but decided against it because <evidence-based reasoning>. The current approach <explanation of why it's better>. Open to discussion.
```

### 7.2 Post Replies via REST API (Primary Method)

Use the REST API to reply to review comment threads. This is the most reliable method.

**IMPORTANT**: You must include `-X POST` explicitly — `gh api` defaults to GET.

The `{comment_id}` is the **numeric ID** of the root comment in the thread (from Phase 1.3 review comments response).

```bash
# Reply to a review comment thread (REST — primary method)
gh api repos/shekhardtu/linty/pulls/{pr_number}/comments/{comment_id}/replies \
  -X POST \
  -f body='Your reply message here'
```

**Alternative** — use the GraphQL API if REST has issues:

**CRITICAL**: `gh api graphql` does NOT support passing GraphQL variables via `-f varName=value` — it causes `Expected VAR_SIGN, actual: UNKNOWN_CHAR` errors. You MUST inline values directly in the mutation string:

```bash
# Reply to a review comment thread (GraphQL — fallback)
# NOTE: Inline the actual values — do NOT use $variables with -f flags
gh api graphql -f query='
  mutation {
    addPullRequestReviewComment(input: {
      inReplyTo: "COMMENT_NODE_ID"
      body: "Your reply message here"
    }) {
      comment { id }
    }
  }
'
```

**IMPORTANT**: The GraphQL mutation uses `inReplyTo` (NOT `pullRequestReviewThreadId`), and it takes the **node_id** of the comment being replied to (NOT the thread ID). The `node_id` is available in the REST API response from Phase 1.3.

**Duplicate reply prevention**: Before posting a reply, check if a reply with the same content already exists in the thread. If so, skip posting.

---

## Phase 8: Resolve Threads on GitHub

After replying, mark qualifying threads as resolved via the GitHub GraphQL API.

### 8.1 Resolution Rules

| Status | Resolve? | Reason |
|--------|----------|--------|
| RESOLVED | Yes | Code changes pushed |
| ALREADY FIXED | Yes | Implementation already satisfies |
| NOT APPLICABLE | **No** | Reviewer may disagree — let them decide |
| NEEDS CLARIFICATION | **No** | Requires human discussion |
| DEFERRED | **No** | Will be addressed later |
| DISAGREE | **No** | Needs discussion — resolving would be dismissive |

### 8.2 Resolve Threads

**CRITICAL**: `gh api graphql` does NOT support passing GraphQL variables via `-f varName=value`. Inline the thread ID directly in the mutation string:

```bash
# NOTE: Inline the actual thread ID — do NOT use $variables with -f flags
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) {
      thread { isResolved }
    }
  }
'
```

Skip threads already resolved (`isResolved: true`).

---

## Phase 8B: Create GitHub Issues for Deferred Items

**MANDATORY**: Any comment classified as **DEFERRED** must be captured as a GitHub issue so it doesn't get lost. Deferred means "valid but out of scope" — it still needs to be done eventually.

### 8B.1 Identify Deferred Comments

From Phase 2 classification, collect all comments with status `DEFERRED`.

### 8B.2 Create GitHub Issues

For each deferred comment, create a GitHub issue:

```bash
gh issue create --repo shekhardtu/linty \
  --title "Brief description of the deferred improvement" \
  --body "$(cat <<'EOF'
## Context

Deferred from PR #NNN review.

**Original review comment by @reviewer:**
> <quote the review comment>

## Description

<What the reviewer suggested and why it matters>

## Affected Files

- `path/to/file.ts`

## Implementation Hints

- <How to implement the improvement>

---
*Created by `/pr-resolve` — deferred from PR review*
EOF
)" \
  --label "tech-debt"
```

### 8B.3 Update Reply

After creating the issue, update the DEFERRED reply on the PR thread to include the issue reference:

```
Valid point. Tracked as #<issue-number>. This is outside the scope of this PR — will be addressed in a follow-up.
```

### 8B.4 Skip Conditions

Skip this phase if there are zero DEFERRED comments.

---

## Phase 9: Request Re-Review

After all comments are addressed, pushed, replied to, and threads resolved — request re-review from the original reviewers.

### 9.1 Identify Reviewers
From Phase 1 metadata, extract reviewers who left `CHANGES_REQUESTED` or review comments.

### 9.2 Request Re-Review
```bash
gh pr edit <PR_NUMBER> --add-reviewer <reviewer1>,<reviewer2>
```

### 9.3 Leave a Summary Comment on the PR (Edit-or-Create)

**IMPORTANT: Never create duplicate summary comments.** Always check for an existing one first and edit it.

#### Step A: Check for Existing Summary Comment

```bash
# Find existing "PR Review Comments Addressed" comment by the bot/current user
gh api repos/shekhardtu/linty/issues/{pr_number}/comments --jq '
  .[] | select(.body | startswith("## PR Review Comments Addressed")) | {id: .id, node_id: .node_id}
'
```

#### Step B: Create or Edit

**If an existing comment was found** — edit it with the updated summary (additive — merge new info into existing):
```bash
gh api repos/shekhardtu/linty/issues/comments/{comment_id} \
  -X PATCH \
  -f body='<updated summary body>'
```

**If no existing comment was found** — create a new one:
```bash
gh pr comment <PR_NUMBER> --body '<summary body>'
```

#### Summary Body Template

```markdown
## PR Review Comments Addressed

All review feedback has been addressed and pushed. Here's a summary:

| Status | Count |
|--------|-------|
| Resolved (code changed) | X |
| Already Fixed | X |
| Not Applicable | X |
| Needs Clarification | X |
| Deferred | X |

**Commits pushed:**
- `abc1234` — fix(scope): description
- `def5678` — fix(scope): description

**Proactive fixes** (issues found beyond reviewer comments):
- Fixed console.log in `path/to/file.ts`
- Replaced `any` type in `path/to/file.ts`

Ready for re-review. @reviewer1 @reviewer2

---
*Resolved by [`/pr-resolve`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/pr-resolve/SKILL.md) — Triggers: "resolve PR", "fix PR comments", "address PR feedback", "resolve PR comments"*
```

**Additive edits:** When editing an existing comment, merge new information:
- Append new commits to the "Commits pushed" list
- Update status counts (don't reset — add to previous)
- Append new proactive fixes
- Keep the full history visible in one comment

---

## Output Format

After completing all phases, provide this final report:

```
===============================================================
 PR REVIEW RESOLUTION REPORT
===============================================================

 Pull Request: <PR_URL>
 Repository: shekhardtu/linty
 Branch: <branch-name>

---------------------------------------------------------------
 REVIEWER COMMENTS
---------------------------------------------------------------

Comment #1: [File: path/to/file.ts, Line: XX]
  Reviewer: @username
  Feedback: "<brief summary>"
  Status: RESOLVED
  Confidence: High (90%) — verified issue exists at line XX
  Reasoning: <why this change was needed>
  Action: <what was changed>
  Reply: Posted | Skipped
  Thread: Resolved | Left Open

... (continue for all comments)

---------------------------------------------------------------
 PROACTIVE FINDINGS
---------------------------------------------------------------
 Fixed:
 - [CRITICAL] Removed console.log in path/to/file.ts:42
 - [HIGH] Replaced `any` with proper type in path/to/file.ts:78

 Noted (not auto-fixed):
 - [MEDIUM] File path/to/file.ts exceeds 500 lines (currently 623)
 - [MEDIUM] Commented-out code at path/to/file.ts:156

---------------------------------------------------------------
 BUILD VALIDATION
---------------------------------------------------------------
 Frontend (yarn build): PASS | FAIL (details)
 Rust (cargo check):    PASS | FAIL | SKIPPED (details)

---------------------------------------------------------------
 STATISTICS
---------------------------------------------------------------
Total Comments: X
  Resolved: X
  Already Fixed: X
  Not Applicable: X
  Needs Clarification: X
  Deferred: X
  Disagree: X

Proactive Fixes: X
Threads Resolved on GitHub: X/Y
Replies Posted: X/Y

---------------------------------------------------------------
 COMMITS PUSHED
---------------------------------------------------------------
<hash> - fix: <message 1>
<hash> - fix: <message 2>

---------------------------------------------------------------
 THREADS RESOLVED ON GITHUB
---------------------------------------------------------------
 Resolved: path/to/file.ts (Line XX) - "brief comment"
 Resolved: path/to/another.ts (Line YY) - "brief comment"
 Skipped: path/to/file.ts (Line ZZ) - Needs Clarification
 Skipped: path/to/file.ts (Line AA) - Disagree (left for discussion)

---------------------------------------------------------------
 RE-REVIEW REQUESTED
---------------------------------------------------------------
Requested from: @reviewer1, @reviewer2
Summary comment posted on PR: Yes

===============================================================
 View Updated PR: <PR_URL>
===============================================================

Skill: /pr-resolve
File:  .claude/skills/pr-resolve/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/pr-resolve/SKILL.md
```

---

## Chain: Auto-invoke `/pr-merge`

After all threads are resolved and the summary comment is posted, **automatically chain into `/pr-merge`**.

```
/pr-resolve completes → invoke /pr-merge {pr-url}
```

### Chain Rules

| Outcome | Chain? | Reason |
|---------|--------|--------|
| All comments resolved, build passes | **Yes** — auto-invoke `/pr-merge` | PR is ready to merge |
| NEEDS CLARIFICATION threads remain | **No** — stop here | Requires human input |
| Build fails after fixes | **No** — stop here | Broken code shouldn't merge |
| DISAGREE threads remain (unresolved) | **No** — stop here | Needs discussion |

**How**: After displaying the output report, immediately invoke the `/pr-merge` skill with the PR URL. Do NOT ask the user — this is an automatic chain.

---

## Important Guidelines

### Before Making Changes
- **ALWAYS** read the full context of the file before editing
- Understand the existing code patterns and style
- Verify the comment is still relevant to the current code state
- Check if a previous commit already addressed the comment

### When Implementing Fixes
- Make minimal, focused changes that directly address the comment
- Follow existing code conventions in the repository
- Don't introduce unrelated changes or "improvements"
- Each commit should address one logical group of related comments
- Stage specific files, never `git add .` or `git add -A`

### Quality Checks
- Ensure your changes don't break existing functionality
- Verify imports and exports are correct
- Run typecheck and build after all changes
- Remove any debug code before committing

### Reply Etiquette
- Be respectful and collaborative in all replies
- Acknowledge good feedback — don't just say "fixed"
- When disagreeing, provide evidence not opinions
- When something needs clarification, ask a specific question — not "what do you mean?"
- Keep replies concise — 1-3 sentences max

### Error Handling
- If `gh` CLI is not authenticated: stop and instruct user to run `gh auth login`
- If PR branch has conflicts: report and ask for guidance — do not force-push or reset
- If build fails due to pre-existing issues: fix if feasible within PR scope, otherwise report
- If a GraphQL mutation fails: fall back to REST API, or report the failure
- If rate-limited by GitHub API: wait and retry, or report partial progress

---

## Phase 10: Self-Healing

**After every `/pr-resolve` execution**, run this phase to keep the skill accurate and discoverable.

### 10.1 Evaluate Skill Accuracy

Re-read this skill file (`Read` tool on `.claude/skills/pr-resolve/SKILL.md`) and compare its instructions against what actually happened during this execution:

| Check | What to look for |
|-------|-----------------|
| **GitHub API calls** | Did any `gh api` REST or GraphQL calls fail due to changed endpoints, field names, or auth issues? |
| **Thread resolution** | Did the GraphQL `resolveReviewThread` mutation work? Did thread ID format change? |
| **Reply posting** | Did REST `/comments/{id}/replies` work? Did it need `-X POST`? Did node_id format change? |
| **Build commands** | Did `yarn build` and `cargo check --features local-stt` work as expected? |
| **Code quality checks** | Are the Phase 4 checklist items still valid for the current codebase conventions? |
| **Workflow phases** | Did any phase need to be skipped, reordered, or modified? |
| **Repo references** | Are all GitHub URLs pointing to `shekhardtu/linty`? |

### 10.2 Fix Issues Found

If any discrepancies were found:
1. Use the `Edit` tool to fix the specific inaccurate section in this skill file
2. Pay special attention to API syntax — REST vs GraphQL, required flags (`-X POST`), field names (`inReplyTo` vs `pullRequestReviewThreadId`)
3. Keep changes minimal and targeted
4. Log each fix:

   ```
   Self-Healing Log:
   - Fixed: <what was wrong> → <what it was changed to>
   - Reason: <why the original was inaccurate>
   ```

If nothing needs fixing, skip silently.

### 10.3 Append Trigger Documentation

After execution, append a skill attribution footer to:

**PR summary comment** (add to the Phase 9.3 summary comment posted on the PR):
```markdown
---
*Resolved by [`/pr-resolve`](https://github.com/shekhardtu/linty/blob/main/.claude/skills/pr-resolve/SKILL.md) — Triggers: "resolve PR", "fix PR comments", "address PR feedback", "resolve PR comments"*
```

**Output report** displayed to the user (add to the final report in Output Format):
```
Skill: /pr-resolve
File:  .claude/skills/pr-resolve/SKILL.md
Repo:  https://github.com/shekhardtu/linty/blob/main/.claude/skills/pr-resolve/SKILL.md
```
