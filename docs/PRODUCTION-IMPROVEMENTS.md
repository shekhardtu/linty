# Reliability and dictation improvements

This change implements ten reliability and dictation improvements for Linty.
It is an initial bounded implementation, not a claim of enterprise certification
or proof that the original force-quit has been diagnosed.

## Behavior and rationale

| Area | Implementation | Reason and boundary |
| --- | --- | --- |
| 1. Main-thread diagnosis | An independent OS thread dispatches one outstanding run-loop probe. It reports a stall after six seconds without acknowledgment and logs recovery. | Audio callbacks or a successfully created event monitor do not prove the main loop can process input. Whole-process scheduling/suspension gaps reset the probe window. It does not terminate or restart the app. |
| 2. Trigger health | Global/local monitor installation is tracked separately, with separate delivered-event counts. Partial installation is retried by the existing watchdog. | Both scopes are needed. Repair waits while the physical trigger is held and reconciles a missing logical release before replacing partial monitors. Inactivity alone never triggers repair. Queued watchdog maintenance is bounded. |
| 3. Short corrections | Verified native observations of one or two words can learn one proper-name spelling substitution that passes the existing spelling classifier. | Ratio-only rewrite detection rejects every one-word correction. Semantic/manual rewrites and common-word changes retain their existing safeguards. |
| 4. Deletion suppression | Deleted dictionary destinations are normalized and persisted with the dictionary transaction. Automatic History/observed learning skips them. | Deleting a learned term should be durable. Explicit manual re-add or accepting a suggestion opts back in. Undoing new learning also suppresses the rejected new term. |
| 5. Lifecycle verification | Native pill stress tests inject a ten-second main-thread stall, check 200 presentations and forced native replacement, and verify renderer acknowledgment. Automatic AppKit window animations are disabled for this overlay; its existing CSS transitions remain. | A failing trace showed 65 blocked native animation workers exhausting the dispatch pool. The overlay already owns its visual fades. Synthetic active-Space faults do not replace physical wake/display/Space testing. |
| 6. Cursor insertion | An opt-in delivery step adds conservative prose boundaries and adjusts a small list of leading function words/greetings. Actual published text is recorded separately from the transcript. | Avoid joined words while preserving names, non-Latin text, code, authored snippets and selected-range replacement. Unknown apps keep literal text. |
| 7. Voice snippets | Persistent local CRUD and exact whole-dictation phrase matching. Saved multiline text bypasses cleanup and dictionary rewriting. | Reusable replies/signatures should retain authored text. No substring expansion or ambiguous phrase selection. Limit: 100 snippets; phrase 120 characters, text 10,000. |
| 8. App writing styles | Persistent bundle-ID overrides for the four existing styles; global fallback. | Use captured application identity instead of another monitoring system. Requires cleanup and app attribution; no domain or window-title inspection. |
| 9. IDE vocabulary | Opt-in selected identifiers become temporary local STT hints. | No repository indexing or background document scraping. Capture is bounded to a 20,000 UTF-16-unit field and a 4,096-unit selection; at most 20 identifiers, within the existing 600-character prompt and 50-term engine vocabulary budgets. |
| 10. Selected-text editing | Opt-in exact voice commands produce a review dialog. Accept uses retained AX selection, verifies the result, and offers guarded Undo. | No arbitrary generative rewriting or keyboard-paste fallback. Changes to the text/selection invalidate acceptance or Undo; previews expire after two minutes. |

Cursor adaptation currently supports TextEdit, Notes, Mail, Messages, Word and
Slack by exact bundle ID. Code, terminals, browsers and unknown applications
keep literal text. Snippets retain their casing and whitespace even in supported
apps. History keeps the recognition/cleanup result in `finalText` and the actual
delivered version in `attemptedText`/`pastedText`.

Supported IDE identities: VS Code/Insiders, Cursor, Zed, Xcode and JetBrains.
Hints include identifiers with underscores or internal capitals; they never
become dictionary entries. Opt-in editor assistance reads the existing bounded
AX field snapshot to verify its selected region, not just the selection API.
Ordinary completed/cancelled sessions release that snapshot. Preview/Undo
snapshots have separate two-minute cleanup timers and clear on Cancel/Done.

The editing commands are English and exact, apart from case and terminal
punctuation: **Linty uppercase**, **Linty lowercase**, **Linty sentence case**,
**Linty trim**, **Linty bullet list**. With editing disabled these are ordinary
dictation. With editing enabled but no supported selection, the command is kept
in History and no paste is attempted. The selected document text is not saved
in History. Unsupported AX writes fail visibly; the user should inspect the
destination if the host accepts a write but does not confirm its result.

## Diagnostics and privacy

No new network service or cloud classifier is introduced. New context and cursor
features default off; snippets/profiles start empty. Dictionary learning retains
its existing preference gates.

On a detected main-thread stall, `/usr/bin/sample` may capture one second of
local stack symbols. Sampling is throttled to once per ten minutes and three
rotating, capped 2 MiB reports under the app log directory's `hang-diagnostics`.
The directory is private to the user; home paths are redacted before retention.
The sampler has a five-second child timeout and uses an explicit controlled
output path rather than leaving an extra report in `/tmp`. Samples do not dump
process memory, audio or transcript content and are never uploaded automatically.
Diagnostic logs/samples remain separate from application-data reset, as described
in the privacy notice. Probe-latency measurements are polling upper bounds,
not precise event-handler durations or keystroke-to-recording benchmarks.

## Verification

- `yarn test`: deterministic regressions, including short corrections, suppression,
  transactional rollback/rehydration, snippet normalization and release-suite parity.
- `yarn test:browsers`: existing WebKit suites plus personalization and editor
  preview/Cancel/Accept/Undo/stale-error UI tests. New feature suites also support
  Chromium through the usual `UI_BROWSER` selection.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --features local-stt,parakeet --lib`:
  monitor retry decisions, probe state, UTF-16 insertion, exact snippet pipeline,
  app-style fallback/privacy and actual delivered-history text.
- `yarn test:capsule-native`: isolated, signed test app; no user microphone,
  installed-app modifications, global hotkeys or clipboard paste. A deliberate
  ten-second stall is confined to this test process, then repeated pill use and
  native replacement recovery are checked.
- The ignored native AX editing test uses the synthetic AppKit fixture with
  `--editor`. It requires Accessibility permission for its test process. Mocked
  browser tests and pure helpers cannot establish that a real host supports
  AXSelectedText writes or Undo.

Before publication, resolve native rehearsal failures and validate supported
external text fields with Accessibility access. Real sleep/wake, display changes,
and everyday use are still required for confidence beyond synthetic tests.

### Current build evidence

The frontend production build and 222 Node regressions pass. The final native
library suite passes 165 tests with five ignored. All ten browser suites passed
individually in WebKit, with the microphone timing suite requiring an isolated
retry after its combined-run failure. The two new feature suites also pass in
Chromium. Static review found no additional material correctness or privacy issue
in the reliability, dictionary, insertion, and editing paths.
The Intel `x86_64-apple-darwin` check with both shipping speech-engine features
(`local-stt,parakeet`) passes. Rust reports the existing upstream `block` crate
future-incompatibility warning.

The original native pill rehearsal reproduced an existing failure: all 200
presentations rendered, but forced replacement never loaded its page. The
unchanged, clean `main` at `42f8d72f7c580a3feb936d63924857727be4ad5d`
also failed at replacement generation 501. LaunchServices launch and removing
the induced stall did not avoid it. Experiments with another data store,
deferred panel conversion, and embedded HTML did not repair it and were removed.

A focused stack sample found 65 separate AppKit `NSAnimation::_runBlocking`
workers and reported the dispatch thread soft limit of 64 reached in every
sample. The main run loop and WebKit content process were idle, so a healthy
main-thread probe alone could not establish rendering health. This worker
exhaustion is consistent with WebKit's asynchronous navigation work not running;
the exact internal callback dependency is not directly proven.

The fix sets the public per-window `NSWindowAnimationBehaviorNone` property on
the pill, including replacement windows. The overlay retains its existing
180 ms CSS fades and reduced-motion behavior. With this change, the strict
200-cycle rehearsal passes: replacement generation 501 acknowledges immediately,
with one induced stall/recovery and zero navigation retries. A follow-up sample found zero blocked
AppKit animation workers and no dispatch soft-limit exhaustion. Native window
visibility alone is never counted as renderer readiness. A separate bounded
readiness retry remains available for transient replacement failures.

This diagnoses the reproduced stress-test failure. It does not prove that the
earlier customer force-quit had the same cause; no stack sample from that event
was available.

Native selected-text editing is a separate permission-dependent test. See
[the isolated test runbook](runbooks/editor-native-rehearsal.md). Browser mocks,
pure helpers, and granting permission alone do not count as a native pass.
The isolated test launch timed out without Accessibility permission; its native
test did not run and is not counted as passing.
This branch has not been published.
