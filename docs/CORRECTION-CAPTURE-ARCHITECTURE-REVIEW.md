# Correction capture: architecture review

Reviewed 2026-09-19 after the real Codex-in-Zed test failed. This is a research and
design decision. The native preview implementation and its coverage limits are
recorded in [the implementation notes](CORRECTION-CAPTURE-IMPLEMENTATION.md).

## Product requirements

- After normal Linty onboarding and OS permission grants, customers should not
  configure individual CLIs, install hooks, or trust commands to learn corrections.
- Keep all edits to a dictation in one editing session and acknowledge the saved
  batch once. Pausing between edits must not generate notifications.
- No fallback notification, manual correction prompt, clipboard extraction, OCR,
  or reconstructed keystroke text. Unverified captures remain silent.
- A successful notification test does not establish capture in a real application.

## What the reference products establish

**Wispr Flow.** Its [data controls](https://wisprflow.ai/data-controls) explicitly
describe monitoring the textbox after dictation and adding corrected spellings.
Its [terminal documentation](https://docs.wisprflow.ai/articles/6478598909-using-flow-with-linux-wsl-and-terminal-applications)
separately describes direct paste and post-paste tracking limitations. A supported
paste destination does not prove correction capture there. The documentation does
not disclose an exact universal submit trigger or the complete native implementation.

The [Canto report](https://wisprflow.ai/canto) describes separating recognition
corrections from ordinary rewrites using audio alignment and edit structure for
model training. This supports separating capture from classification, but is not
documentation of the shipping personal-dictionary classifier or OS event collector.

**VoiceInk, open source.** Reviewed commit
`59cdee8a61d2d1369cc940660336f0770cfe745a`. Its components are explicit:

- [AX reader](https://github.com/Beingpax/VoiceInk/blob/59cdee8a61d2d1369cc940660336f0770cfe745a/VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXTextReader.swift): application and system focus; editable-field checks; text ranges, values, and browser text markers; reversible activation of supported web accessibility.
- [AX runtime](https://github.com/Beingpax/VoiceInk/blob/59cdee8a61d2d1369cc940660336f0770cfe745a/VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift): retained target, original field text, and pasted range; final snapshot on completion.
- [Service](https://github.com/Beingpax/VoiceInk/blob/59cdee8a61d2d1369cc940660336f0770cfe745a/VoiceInk/Features/Dictionary/AutoLearn/AutoLearnService.swift): focus lifecycle, finalization, review queue, dictionary application, then notification.

Its [Auto Learn documentation](https://tryvoiceink.com/docs/auto-learn-dictionary)
names focus departure, another dictation/paste, and observation expiry as completion
events. Changed passages are reviewed to distinguish reusable corrections from
ordinary edits. Vocabulary hints and explicit replacement rules are separate outputs.
It explicitly says inaccessible fields cannot be observed. This is not proof of
universal terminal coverage or an Enter-only mechanism.

**Superwhisper.** Its [vocabulary documentation](https://superwhisper.com/docs/get-started/interface-vocabulary)
describes recognition hints and deterministic replacements after transcription.
Its [context documentation](https://superwhisper.com/docs/common-issues/context)
describes selected-text, clipboard, and active-window context captured during the
dictation workflow. These pages do not establish automatic learning from edits in
every app. No equivalent edit-observation implementation was verified in this review.

## Findings in the failing Linty workflow

The test dictation was inserted into a Codex CLI hosted in Zed. The original forms
included a project name and a technical term; the prompt contained the expected
spellings. No correction
record for that dictation reached Linty's history or learned dictionary.

The native probe had Accessibility permission, but Zed exposed an `AXWindow`, zero
children, and no readable text value. For a stronger comparison, the unmodified
VoiceInk AX reader from the pinned commit was compiled in a temporary research
harness, with its documented reader limits, and run against the same installed Zed
process. It returned **zero editable-text readings**. No field contents were printed.
This tested the reader, not the full VoiceInk application or Wispr Flow.

There is also a separate learning-policy issue: the current Linty rules treat a
capitalized correction as ready after one occurrence, while lowercase `yolo` needs
another sighting. Even successful capture would therefore not necessarily produce
the two-word acknowledgment expected in this example.

The CLI hook experiment solved a narrower submission transport problem but required
per-product configuration and trust. Linty's manually installed Codex and Claude
hooks have now been removed, preserving unrelated settings. Reading CLI prompt
history was investigated only; it has not been implemented as another capture path.

## Proposed architecture

1. **Native capture adapter.** Bind the real insertion target, process, selection,
   and dictated range. Read only supported, bounded text capabilities. Record a
   content-free capability result when the app cannot expose the field.
2. **Editing-session controller.** Keep the original insertion and current verified
   text separately. Track revisions, composition, undo, focus, cancellation, and
   multiple dictations in the same draft. Edit pauses only update state.
3. **Finalization and correction classifier.** A verified editing boundary yields
   one final diff. Enter alone is not sufficient. Evaluate each local correction
   using edit structure and context, including lowercase names and split/join
   corrections. Reject rewrites and uncertain final text. Classifier behavior must
   be evaluated independently of capture success.
4. **Dictionary transaction and acknowledgment.** Save accepted vocabulary or
   replacement changes together, then emit one saved-batch event. The pill displays
   the actual learned count and Undo. Subsequent dictation uses the shared dictionary.

These components need clear contracts, but additional abstraction alone cannot
make an inaccessible terminal expose its text. The Zed case remains an explicit
coverage gap until a native, customer-effortless capture method is demonstrated.

## Validation before another coverage claim

Use one real interaction harness across native fields, browser editors, Electron
editors, terminal emulators, and hosted CLIs. Exercise multiple corrections,
last-character-plus-Enter, mouse submission, Shift+Enter, undo/redo, composition,
focus changes, and repeated dictations. Measure capture success, incorrect learning,
duplicate notifications, and acknowledgment latency separately.

For the failing Zed terminal, compare a reference product in the exact same input
control before claiming parity. The present evidence supports broad accessibility
coverage; it does not establish reliable, zero-setup correction capture in every app.
