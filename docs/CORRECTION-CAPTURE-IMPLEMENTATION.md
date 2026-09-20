# Native correction capture: macOS preview

Implemented 2026-09-19 from the [architecture review](CORRECTION-CAPTURE-ARCHITECTURE-REVIEW.md).
This is a local preview, not a claim of universal application coverage.

## Behavior

Linty binds the active editable field and its UTF-16 selection before pasting.
After paste, it verifies the insertion against that exact selection and the
surrounding text. It keeps the original insertion separately from later edits.
Pauses update the draft; they never show a correction notification.

An editing session finishes when either:

- Focus has left the retained field for at least 250 ms and a current, settled
  read still matches the last verified draft; or
- Return is followed by the field clearing or being replaced by the host. The
  final draft is frozen from a verified read completed before the actual Return
  event, with a matching input revision. The host's response is never used as the
  corrected text. Return alone is insufficient; an inserted newline continues
  the same editing session.

Accepted corrections are saved together. Only a successful save produces one
pill: **“2 corrections learned — I’ll remember them next time.”** Review opens the
shared Dictionary. Undo reverses that batch while preserving later unrelated
changes. When Dictionary is disabled, the acknowledgment explicitly says it must
be enabled before saved entries will apply.

The acknowledgment stays for three seconds. Hovering over it or focusing an
action pauses dismissal; leaving resumes only the remaining time. A dictation
that interrupts an already shown acknowledgment dismisses it permanently. A new
acknowledgment received during dictation waits to appear once afterward.

Multiple dictations appended to the same draft remain one session, with separate
originals and one final dictionary save. Pasting over or inside earlier text drops
those older attributions; Linty's own new dictation must never become a purported
user correction of its predecessor.

## Components

- `src-tauri/src/corrections/accessibility.rs`: main-thread active-process lookup,
  application-owned focused field, advertised text protocol, pre-paste selection,
  bounded reads, AX notifications, and temporary passive input revisions. Field
  focus is verified with the application's native `AXFrontmost` and focused-element
  attributes. No key characters are captured.
- `src-tauri/src/corrections.rs`: one worker and ordered paste/stop messages. The
  watcher pauses before Linty posts Cmd+V, then attaches the verified insertion.
- `src-tauri/src/corrections/session.rs`: original insertions, current verified
  snapshot, composition, focus departure, input freshness, expiry, and final batch.
  Sixteen bounded verified reads preserve event ordering when the OS delivers
  input callbacks late. Reads completed after Return cannot validate submission.
  A changed value after blur, or without a new edit revision, is discarded.
- `src-tauri/src/corrections/diff.rs`: word changes restricted to each dictated span.
- `src/lib/correction-classifier.ts`: conservative local spelling evidence,
  including lowercase words, transpositions, and split/join names. Capitalization
  alone does not qualify an unrelated replacement. This is a lexical heuristic,
  not an audio-aligned or semantic model; similarly spelled semantic changes can
  still be ambiguous. Large rewrites, everyday targets, conflicting replacements,
  and unrelated substitutions in the evaluation examples are excluded.
- `src/services/dictionary.service.ts`: serialized session-level dictionary save
  with autosave disabled, rollback of the plugin cache on save failure, actual
  accepted count, and batch Undo. History records
  are stored separately; this is not a cross-database atomic transaction.
- `src/hooks/useCorrectionObserver.hook.ts`: deduplicates session events, records
  corrections, saves learning, then asks the existing native capsule to show it.

The Codex/Claude CLI bridge, hook helper mode, socket listener, installer, and their
experimental tests have been removed.
No CLI history watcher, manual add prompt, OCR, clipboard reader, reconstructed
keystroke text, or alternative notification path was introduced.

## Deliberate coverage limits

The current native adapter requires an editable text role, readable complete
text, and `AXSelectedTextRange`, plus a working passive input monitor. It chooses the advertised range or value protocol
once; a failed read does not switch sources. Browser text-marker protocols and
accessibility activation are not implemented in this preview.

The installed Zed terminal still exposes an `AXWindow` with no readable text.
Codex and Claude hosted there remain unsupported and silent. Native terminal,
Electron, and browser-editor coverage has not been established by the mocked UI
tests. Windows and Linux adapters are not part of this change.

Other silent outcomes include unchanged/undone edits, ambiguous insertion,
composition, destroyed fields, stale last-character-plus-Enter captures, and
unverified clearing. Clicking Send is not a universal submit signal: if it clears
the field before a verified final read, the session is discarded. There is no
idle timeout notification. Sessions expire after two minutes, permit up to 16
appended dictations, read at most 20,000 UTF-16 units, and diff at most 2,000 words
per side. Full field text remains in the native session; only changed pairs and
metadata leave it.

## Validation

Latest run: 26 native correction tests passed (including both real AppKit tests),
12 dictionary/diff/classifier tests passed, Chromium and WebKit correction UI
checks passed, and the release preview build succeeded. Signing and local launch
are separate from these test results.

The correction unit suite covers native session boundaries, final-character races,
composition, clearing without submission, expiry, undo, UTF-16 selection, repeated
phrases, multiple appended dictations, replacement dictation attribution, and
edits outside the dictated span. Search-to-URL regression cases verify that an
unchanged query creates no correction record and a corrected query retains only
its spelling change. They also cover late Return delivery, reads that straddle
Return, replacement prompts, confirmation messages, preserved submit signals,
Shift+Return, and Cmd+Tab.

The real AppKit fixture exercises cross-process AX range reads and notifications.
Its session test also activates a synthetic text view, makes two edits, restores
the previously active application, and verifies one final two-correction batch.
It supplies the fixture process ID directly; the production main-thread process
lookup and actual Linty paste are not part of that test. The fixture uses no
clipboard or synthetic keyboard input and does not modify the user's dictionary.

```sh
swiftc scripts/fixtures/correction-accessibility.swift -o /tmp/linty-correction-accessibility-fixture
LINTY_CORRECTION_FIXTURE=/tmp/linty-correction-accessibility-fixture cargo test --manifest-path src-tauri/Cargo.toml --lib corrections:: --no-default-features -- --include-ignored --test-threads=1
node --experimental-strip-types --test tests/corrections.test.mjs
node tests/ui.correction-feedback.mjs
UI_BROWSER=webkit UI_PORT=1479 node tests/ui.correction-feedback.mjs
```

Browser tests use synthetic native events to verify one save per session, lowercase
learning, multiple dictations, event deduplication, actual replacement on next use,
Undo, persistence failures, quiet unsupported capture, queueing behind dictation,
three-second dismissal, no replay after interruption, hover/focus pauses,
reduced motion, themes, and accessibility. A captured `Kanto → canto` correction
is checked through History, dictionary persistence, and acknowledgment. These
simulated browser events do not establish native app coverage.

For a manual preview test, dictate “My name is Hari Shekhar. I go to YOLO.” in an
accessible native text editor. Correct it to “My name is Harishekhar. I go to YULU.”
Then move focus to another application while leaving that text intact. Expect one
saved-learning pill if the entries were not already known. Undo removes that batch.
