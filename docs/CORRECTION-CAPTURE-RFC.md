# Correction capture across applications: research and implementation RFC

Research date: 2026-09-19. This RFC includes future work beyond the macOS preview. See [the implementation notes](CORRECTION-CAPTURE-IMPLEMENTATION.md) for what is built, validated, and still limited.

Current direction: per-CLI hooks and prompt-history monitoring are not the accepted
product architecture. The experimental CLI bridge has been removed. See the
[architecture review](CORRECTION-CAPTURE-ARCHITECTURE-REVIEW.md) for fresh source
inspection, a direct VoiceInk reader test against Zed, and the unresolved coverage gap.

The objective is to recognize corrections to Linty's dictation, collect several edits into one batch, and acknowledge saved dictionary changes once the person finishes. The current requirement excludes fallback paths: unavailable, ambiguous, unchanged, or unsaved results stay silent.

## Decision

Build capture around **the text the application exposes**, using accessibility notifications to refresh it. Use keyboard and mouse events as hints about editing and submission. Maintain the original dictation and the latest trustworthy edited version separately from notification timing.

No API examined provides both the final text and a universal “submitted” event for arbitrary desktop applications. A Return key can submit a chat, insert a newline, confirm an input-method candidate, accept completion, or execute a shell command. An emptied field can mean submit, clear, undo, or cancellation. Neither is sufficient evidence alone.

Use two explicit capture adapters:

| Path | Text source | Completion signal | Result |
| --- | --- | --- | --- |
| General desktop capture | Accessibility text, ranges and selection | App-specific submission evidence; otherwise end of editing | Automatic learning only with trustworthy capture and a reusable correction |
| App/terminal integration | Editor model or final command supplied by the host | Host submit callback or command-start event | Strongest association between final text and submission |

Broad automatic coverage is feasible. Inaccessible applications need a supported integration to provide final text; otherwise capture stays silent. OCR and keyboard reconstruction do not remove that requirement reliably.

## What existing products establish

Wispr's [data-controls documentation](https://wisprflow.ai/data-controls) confirms that Auto-add monitors the pasted textbox for spelling changes. Its [terminal guide](https://docs.wisprflow.ai/articles/6478598909-using-flow-with-linux-wsl-and-terminal-applications) documents limitations for secure fields, lost focus and noneditable focused elements. These pages do not establish an Enter-only trigger or automatic learning in every terminal UI.

A [firsthand binary/log investigation by Wensen Wu](https://www.wensenwu.com/thoughts/wispr-flow-investigation), dated 2026-04-04, examined Wispr 1.4.752. It reports a native edited-text listener starting around paste, accessibility textbox reads, and a separate CGEventTap keyboard service. The reproduced logs include an edit-capture skip for a large textbox. This is independent, version-specific evidence, not a verified description of current Wispr or its exact completion policy. We have not reproduced that analysis; its wider claims are outside this investigation.

VoiceInk's [Auto Learn documentation](https://tryvoiceink.com/docs/auto-learn-dictionary) explicitly names its completion events: leaving the field, starting another dictation, pasting another result, or reaching the observation deadline. It also acknowledges inaccessible fields. That is a concrete example of batching without depending solely on Enter.

Its open-source [text reader](https://github.com/Beingpax/VoiceInk/blob/cd1d96f182b03561f5ef66c6a91e511cd7409c4c/VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXTextReader.swift) tries range-based reads, plain values and text-marker reads, and manages `AXManualAccessibility`. Its [runtime](https://github.com/Beingpax/VoiceInk/blob/cd1d96f182b03561f5ef66c6a91e511cd7409c4c/VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift) retains a target element and pasted range for a final snapshot. This provides implementation evidence for a richer reader. It does not prove that the reader handles our Zed build. No upstream implementation was copied into Linty.

## macOS: APIs and useful events

Apple's local macOS SDK headers were inspected alongside the published API documentation. `AXObserverAddNotification` explicitly allows unsupported-notification errors, and the system-wide AX element does not support notifications. Create an observer for the target process, register on its application/field elements, and attach its source to a running CFRunLoop. [Apple AX observer API](https://developer.apple.com/documentation/applicationservices/1462089-axobserveraddnotification)

| Signal | What it tells us | Intended response |
| --- | --- | --- |
| `AXValueChanged` | Exposed content changed; it may include application-generated changes | Read the retained field; update the session snapshot silently |
| `AXSelectedTextChanged` | Selection or caret changed | Refresh selection and text if necessary; never learn solely from selection |
| `AXFocusedUIElementChanged`, window/app deactivation | Editing context may have changed | Attempt a bounded final read of the retained field; end or briefly suspend the session |
| `AXUIElementDestroyed` | Target is gone | Stop reading that reference; classify cached data as potentially incomplete |
| Key-down for Return, keypad Enter, configured Cmd/Ctrl+Return | Possible submission | Record a candidate boundary and reconcile it against actual field/app behavior |
| Shift+Return, IME composition, completion acceptance | Often continued editing | Keep observing unless the app provides explicit submission evidence |
| Delete, paste, undo/redo, ordinary typing, navigation | Cached text/selection may be stale | Request a refresh; do not reconstruct final text from key names |
| Mouse-down/up around the target | Could select text, reposition the caret or press Send | Refresh target state; a click alone does not prove submission |
| Escape / cancellation indicated by host | Work may have been discarded | Discard candidates associated with canceled content |

Event coverage is capability-dependent. An app may implement text reads but omit useful notifications. Successful observer registration must be distinguished from measured notification delivery.

### Text reader

At dictation insertion, identify the target process and field. Try both application focus and system focus, check ownership, then use bounded parent/child traversal or hit testing when a custom container owns focus. Do not simply choose the first text-looking descendant: bind it to the actual insertion using selection and pasted-span evidence.

Try public `AXValue` and `AXStringForRange` / `AXAttributedStringForRange` with supported character-count/range attributes. Request a bounded area around the dictation when possible, rather than rejecting an entire long document. Selection ranges use native text offsets; the adapter must explicitly convert them to the core's coordinate system. Never confuse UTF-16 units, Unicode scalar counts, UTF-8 bytes and grapheme clusters. [Apple parameterized reads](https://developer.apple.com/documentation/applicationservices/axuielement), [Apple range attribute](https://developer.apple.com/documentation/applicationservices/kaxstringforrangeparameterizedattribute)

Browser text-marker attributes are an additional compatibility path, evidenced by the VoiceInk reader above. Treat them as capability-detected, app-tested extensions rather than a universal stable interface. `AXSelectedText` alone is useful for a deliberate “Remember this selection” action; it is not the whole document.

Electron documents [setting `AXManualAccessibility` on the application element](https://www.electronjs.org/docs/latest/tutorial/accessibility). Use it only for a supported adapter, preserve prior state, and coordinate ownership across overlapping sessions. Do not toggle `AXEnhancedUserInterface` indiscriminately. An attribute being advertised as settable does not establish that setting it works.

Run AX reads on a serial worker, with bounded messaging timeouts and bounded traversal. Notifications schedule reads instead of doing diffs, storage or network work inside callbacks. Retain/release observer context safely, remove subscriptions on shutdown, and reject stale results using session generation IDs. [Apple messaging timeout](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)

### Keyboard monitoring and the submission race

`NSEvent.addGlobalMonitorForEvents` delivers copies **asynchronously**, and cannot stop delivery to the target. Therefore “Return observed, now read the textbox” can be too late. The app may already have cleared it. [Apple global event monitor](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents(matching:handler:))

Start with passive monitoring for submission candidates and refresh hints. A `CGEventTap` with `listenOnly` offers lower-level events if measurement justifies it, but does not give an atomic editor snapshot or the semantics of Send. Avoid holding or replaying Return while waiting for AX: that puts typing behind cross-process IPC and still does not establish editor/IME semantics. Keep callbacks short and handle tap disablement. Check permission availability, including [listen-event access](https://developer.apple.com/documentation/coregraphics/cgpreflightlisteneventaccess()), rather than assuming existing AX permission guarantees every monitoring path. [Apple event-tap API](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:))

Maintain a revision counter for observed edit hints and snapshots. If a possible edit follows the last successful read and the field disappears before reconciliation, the final text is uncertain. Do not auto-learn from that stale snapshot. Even with this check, AX notifications are not a complete ordered edit log; an app integration gives stronger guarantees.

Secure Event Input can interrupt key observation. Keyboard-only tracking must never be the correctness foundation. Karabiner's [implementation notes](https://github.com/pqrs-org/Karabiner-Elements/blob/main/DEVELOPMENT.md) describe this failure mode and the need to reconcile modifier state after capture resumes.

## Local Zed result

Environment: macOS 26.5 (25F71), installed `dev.zed.Zed` version 1.20.2, bundle build 20260917.044955. The read-only probe examined a hosted terminal prompt.

| Probe | Observed result |
| --- | --- |
| AX trust | Granted to the diagnostic process |
| Focused element | `AXWindow` / `AXStandardWindow` |
| Children, contents and visible children | Zero returned |
| Text value | `kAXErrorAttributeUnsupported` (`-25205`) |
| Public text-range read attributes | No usable read attributes reported |
| Application focus observer | Registration succeeded; no events in the short quiet observation |
| `AXManualAccessibility` | Unsupported |
| `AXEnhancedUserInterface` | Advertised settable; a separate attempt returned `kAXErrorNotImplemented` (`-25208`) |

The enhanced-accessibility attempt did not succeed. It did not supply the missing editor. The probe did not change focus, copy text, type, or log field contents. This is evidence about the observed state of this build, not every version or field in Zed.

Current upstream Zed installs an AccessKit adapter in its [macOS window implementation](https://github.com/zed-industries/zed/blob/72b060af2e901406f9cf4a050c4f30bb479103fe/crates/gpui_macos/src/window.rs). AccessKit's [adapter](https://github.com/AccessKit/accesskit/blob/4897f1325fad0217c99a80bf772e22266fc203b4/adapters/macos/src/adapter.rs) requests an initial tree when accessibility children/focus are queried. These revisions have not been matched to the installed binary. Do not assume Electron's activation switch applies to a GPUI editor.

The affected prompt belongs to a CLI inside a terminal, rather than Zed's native chat editor. The CLI hook experiment was removed because it required per-product setup. Zed accessibility alone cannot establish whether a hosted CLI exposes its prompt; this control remains unsupported by the native preview.

Reproduce the metadata-only probe:

```sh
swift scripts/probe-correction-accessibility.swift dev.zed.Zed 3
# The first argument can also be a process ID; duration is bounded to 15 seconds.
```

The script reports capabilities and notification counts. It does not certify full correction capture or submission detection.

A separate native `NSTextView` control with synthetic name/place edits and clearing exposed `AXValue`, `AXStringForRange`, selection and marked-text attributes. The out-of-process probe received four `AXValueChanged` and seven `AXSelectedTextChanged` notifications over four seconds. This establishes delivery for the control, not an exact one-event-per-edit guarantee. The reproducible fixture is `scripts/fixtures/correction-accessibility.swift`; compile it and probe its process ID. It creates a background window for six seconds without activating it or sending input to another app.

## Terminals: two distinct text owners

The terminal emulator can expose rendered text through accessibility, but that buffer can include prompts, output and scrollback. A shell, REPL, Vim, or terminal chat application separately owns the editable input. Track the dictation's range and cursor context; never diff the entire screen and learn replacements from command output.

iTerm2's [shell-integration escape sequences](https://iterm2.com/documentation-escape-codes.html) define `OSC 133;A/B/C/D` for prompt, input, command execution and completion/abort boundaries. The command text is derived from the marked screen region when execution begins. These sequences are terminal protocol messages, not macOS notifications available to every app. Linty would need access through a terminal adapter/API or a cooperating shell.

The [iTerm2 `PromptMonitor` API](https://iterm2.com/python-api/prompt.html) provides `COMMAND_START` together with the command string, which is a particularly useful integration for final-command comparison. Require the appropriate shell integration and correlate the terminal session with the dictation session. Do not assume this covers another terminal or a TUI's internal input.

For zsh, [`preexec`](https://zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions) runs after a command has been read and before execution. Its first argument is the typed command when history is active; later arguments can contain expanded forms. [`zle-line-finish`](https://zsh.sourceforge.io/Doc/Release/Zsh-Line-Editor.html#Special-Widgets) and editor-buffer hooks can assist capture, but finishing line editing alone is not proof of execution. Any integration must preserve existing hooks and connect to a scoped local session; do not scrape the user's shell history.

A shell hook cannot inspect text typed inside an already-running CLI chat, REPL or terminal editor. Those require readable accessibility or a supported tool integration. Per-CLI submission hooks are outside the accepted product architecture. Bracketed paste identifies a paste payload; it is not a correction or submission protocol.

## Linux: AT-SPI first, compositor-specific events second

Use the AT-SPI accessibility bus and [`Atspi.Text`](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Text.html) for text, caret and selection. Subscribe to `object:text-changed`, `object:text-selection-changed`, `object:text-caret-moved`, focus-state changes and target destruction. The [event-listener API](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EventListener.register.html) enumerates these events. The [D-Bus event interface](https://github.com/GNOME/at-spi2-core/blob/main/xml/Event.xml) carries text-change position, length and a text payload variant. Verify each toolkit's actual payload and reconcile against snapshots; do not assume all providers emit complete deltas.

Under X11, the [RECORD extension](https://xorg.freedesktop.org/archive/X11R7.7/doc/recordproto/record.html) can expose protocol/device events. It still does not reveal the editor's semantic buffer or distinguish submit from newline. Treat it as an optional event-hint source, not a portable Linux implementation.

Under Wayland, the [GlobalShortcuts portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html) registers application actions and reports their activation. It is useful for dictation and an explicit “Remember correction” shortcut, not arbitrary global observation of other apps' Enter keys. The [InputCapture portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.InputCapture.html) defines compositor-controlled capture sessions with user mediation; it is not a general passive textbox observer.

GNOME has added accessibility keyboard support, documented in its [2025 GTK update](https://blogs.gnome.org/gtk/2025/05/12/an-accessibility-update/). That progress does not establish uniform support across GNOME, KDE, wlroots, sandbox configurations and app toolkits. Probe capabilities on each supported environment. The [Newton architecture work](https://blogs.gnome.org/a11y/2024/06/18/update-on-newton-the-wayland-native-accessibility-project/) is relevant design background, not evidence that every current Linux desktop has deployed it.

The [Wayland text-input-v3 protocol](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/unstable/text-input/text-input-unstable-v3.xml) includes surrounding text, cursor/anchor and composition state between participating clients and the compositor. It is not a permission for an unrelated application to read every other client's text. An input-method integration is a separate product/compatibility commitment.

Linux support is researched here, not implemented or tested on this Mac.

## Browser and editor integrations

A browser extension or cooperating editor can observe editing closer to its source. The [W3C Input Events Level 2 working draft](https://www.w3.org/TR/input-events-2/) distinguishes text insertion, replacement, paste, undo/redo and composition via `beforeinput` / `input` and `inputType`. These events belong to the document; Linty needs an authorized integration to receive them. A form's submit callback or an editor's send action can capture the final value before clearing. Custom chat UIs may not use an HTML form, so DOM submit is not universal either.

The exact-editor path is the strongest solution for an otherwise inaccessible field. It should pass the dictation session ID, changed span, final text and completion reason to Linty, rather than expose unrelated document contents.

## Research papers: deciding which changes to remember

Capturing an edit and deciding whether it is a reusable recognition correction are separate problems.

| Work reviewed | Applicable finding | Implication for Linty |
| --- | --- | --- |
| [FastCorrect, NeurIPS 2021](https://arxiv.org/html/2105.03842v6) | Uses edit alignment for substitutions, deletions and insertions; alignment can be ambiguous | Preserve unchanged context and support split/join errors; a diff is evidence, not a complete classifier |
| [Towards Contextual Spelling Correction, 2022](https://arxiv.org/html/2203.00888v2) | Filters context lists and controls bias to reduce regressions on unrelated utterances | Prefer relevant vocabulary and confidence checks; do not globally force every similar-sounding word to a saved name |
| [Evaluation of Interactive User Corrections, IWSLT 2012](https://aclanthology.org/2012.iwslt-papers.10.pdf) | Its German lecture study found edits useful but noisy, including spelling/compound mistakes | Do not treat every edit as a ground-truth training label; this study's accuracy numbers are not Linty thresholds |
| [Wispr Canto technical report, 2026](https://wisprflow.ai/canto) | Describes audio-alignment and edit-location/shape signals to separate recognition errors from rewrites for training | Later evaluate audio-supported correction scoring; it does not disclose how OS edits are captured |

Start with local deterministic candidate extraction and a review path. Measure whether optional local semantic/phonetic scoring improves decisions before adding it. Model training is not required for the first dictionary feature. Saving vocabulary or a replacement is also not the same as learning a person's acoustic pronunciation.

Important examples: `Hari Shekhar → Harishekhar` is a split/join candidate; `YOLO → YULU` is a substitution candidate. `Tuesday → Wednesday` may be a changed plan, and `clod → Claude` may depend on context. Capitalization alone should not grant a permanent global replacement.

## Proposed Linty session model

Separate capture quality, correction eligibility and persistence status:

```text
Paste target + original dictated span
    → observe changes silently
    → track final edited span and evidence quality
    → finish once, or mark capture incomplete
    → classify each candidate independently
    → save vocabulary / replacement / suggestion
    → one acknowledgment after successful persistence
```

Retain an immutable original insertion, its surrounding anchors and target identity. Preserve a current snapshot and selection, a monotonically increasing revision, observation capabilities, and the reason the session ended. The snapshots stay in memory; only the scoped corrections needed by the dictionary should survive finalization.

If several dictations enter the same still-open draft, group their tracked spans into one editing session. Treat Linty's later insertion as its own change, not a human correction. Emit one acknowledgment for the completed group. Scope a repeated sighting to a distinct dictation/correction, not every poll or key event.

Proposed completion policy:

| Situation | Learning / UI behavior |
| --- | --- |
| Verified host submission with final text | Diff, classify, persist, then one acknowledgment |
| Enter/click plus a compatible field transition and trustworthy final snapshot | Finish the batch; retain that submission was inferred |
| Enter creates a newline or accepts composition | Continue silently |
| Focus leaves the field or another dictation starts | Bounded final read; complete an editing batch, without claiming it was submitted |
| Field clears without submission evidence | Treat as ambiguous/canceled; do not learn from stale cached text |
| Observation expires while the person is still editing | End background capture silently |
| Source becomes unreadable or final revision is uncertain | No learning or notification |

Short refresh coalescing is an implementation detail, not a notification timer. Benchmark initial targets such as 50–100 ms coalescing; do not present them as proven final-text guarantees. Polling cannot eliminate the edit-and-submit race.

Final diff must compare the original to the final version. If the person tries `YU`, pauses, changes it to `YULU`, then submits, only `YOLO → YULU` is eligible. If they undo the change, there is no candidate. If they fix a name and also rewrite an unrelated clause, assess the name locally rather than rejecting the whole message solely on a global changed-word ratio.

Show the count actually saved, not the number of arbitrary edits. Example: **“2 corrections learned” / “I’ll use these spellings next time.”** Offer Undo linked to the saved batch. With automatic learning disabled, evidence requiring review, or a failed write, show no automatic pill.

The earlier proposed **“Remember a correction…”** path has been removed. Do not invent the corrected word, automatically select/copy the entire field, or display a learned pill merely because a key was pressed.

## Gaps identified before implementation

The following findings describe the original implementation. See the implementation notes for the current preview and remaining limits.

- `src-tauri/src/corrections.rs` reads only a string `AXValue` from system focus. It has no range/marker reader or app-specific activation path.
- The watch starts after paste with a 400 ms initial delay, polls every second, ends after 60 seconds, and currently reports after a two-second pause. This misses fast final edits and can acknowledge intermediate spellings.
- It treats an empty field as submission and preserves the prior snapshot. That can confuse submit with deletion/cancellation and retain incomplete text.
- Its fixed whole-field size cap rejects long editors/terminal buffers instead of reading a bounded dictation area.
- `useCorrectionObserver` can persist and display a pill once given a valid event; improving the pill alone cannot recover missing native observations.
- The current global rewrite threshold can suppress a valid local name correction mixed with a larger rewrite. Proper-noun capitalization is also only a heuristic for eligibility.
- Existing synthetic UI tests establish persistence and feedback behavior, not real accessibility coverage in Zed, terminals, browsers or other native apps.

## Implementation sequence and release evidence

1. Introduce capability reporting and a pre-paste target/span capture API. Keep insertion latency bounded; dictation still succeeds if observation cannot start.
2. Add macOS range/value readers, bounded target discovery, per-process AX observers and passive submission hints. Keep compatibility extensions isolated and measurable.
3. Replace repeated settled-edit reporting with final session batches. Add explicit incomplete/canceled states and group successive dictations in the same draft.
4. Implement batch review/Undo and count only persisted learning. Unavailable capture stays silent.
5. Add explicit terminal/editor integrations. Validate hosted CLI prompts separately from the terminal host's native fields; do not claim support from a pill simulation.
6. Port the shared state machine to an AT-SPI adapter, then evaluate X11 and each intended Wayland environment.

Native acceptance cases must cover: multiple corrections with pauses; immediate last-character-plus-Enter; Send by mouse; Shift+Enter; configurable Enter behavior; IME candidate acceptance; emoji/combining text; paste replacement; undo/redo; select-all/delete; Escape; switching fields in one app; reopening a draft; two dictations before one submission; repeated original words; long documents; terminal output arriving during editing; shell continuation; CLI chat prompts; permission loss and unavailable notifications.

Measure **final-text capture recall**, **incorrect automatic-learning rate**, **duplicate acknowledgment count**, callback/read latency, and idle CPU separately. Record capability failures by app/version and reason without logging field text or key contents. Passing unit/UI tests is necessary but insufficient: release coverage must name the native applications and input controls exercised.

The success criterion for any additional application is a real dictated-text edit, one persisted batch and one acknowledgment, followed by correct reuse in another app. Hosted CLI prompts in the tested Zed build do not meet that criterion and remain an explicit coverage gap.
