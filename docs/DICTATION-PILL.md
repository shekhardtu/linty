# Dictation pill and hands-free listening

The capsule uses the generated Linty favicon artwork as inline SVG (the same
`src-tauri/icons/icon.svg` that produces `public/brand/favicon.png`). Its three
strokes keep the landing page's staggered, centered movement, with their heights
driven by recent microphone levels rather than a repeating animation. Reduced
motion keeps the favicon still. Listening uses a 234 × 40 px pill.
Input levels form a small scrolling waveform; silence
settles to dots. The visual response maps RMS over -72 to -6 dBFS, then squares
that level so low room noise stays close to the 2 px baseline. Ordinary input
uses the middle of the 20 px display; loud input has room to move. The maximum
bar height is 18.2 px, leaving space at both edges. An eased attack and longer
release soften small fluctuations. This display curve also drives the favicon;
it does not change recorded audio, speech detection, or the inactivity deadline.
There is no continuous canvas draw loop.

The in-app Microphone Test shares this response curve in an 80-bar, full-width
display. Each native amplitude frame advances the history, including repeated
silence. Its level listener exists only while recording. The last three results
remain readable and copyable until the user leaves the screen, independently of
the shared dictation reset timers. Empty results and errors preserve earlier text.

Starting dictation with the configured shortcut while Linty is focused opens a
recording view that fills the existing window. The originating page stays mounted,
preserving its settings section, search, selection, and scroll position. After
processing finishes, a visible ten-second countdown returns to that page. Back now
returns sooner; Stay here cancels the countdown. A new recording resets it. The
countdown controls remain visible while long transcripts scroll. External-app
dictation continues to use the capsule. Run `yarn test:microphone` for the interface
regressions, or `UI_BROWSER=webkit yarn test:microphone` for WebKit.

When listening finishes, the row fades over 140 ms as the same shell contracts
around its center to a **40 × 40 px circle** over 360 ms. The favicon moves with
the shell and transitions into a rotating arc; its artwork is never stretched
by the contraction. Preparation uses this same compact state. Transcription,
correction and pasting keep one continuous orbit, without restarting the motion
or flashing intermediate labels. On successful delivery, the arc settles away as a
checkmark draws in the same position. Success remains for 1.1 seconds before a
180 ms fade. Fast results can transition directly to the check during contraction;
there is no artificial processing delay. A new recording reverses the contraction
and cancels any old dismissal. Errors expand into a readable row. A failed paste
shows “Paste failed · open Linty” instead of a checkmark or success sound; the
transcribed text remains available in the app.

The outgoing row stays mounted for its fade but immediately becomes inert and
leaves the accessibility tree. Screen readers still receive listening, processing,
success and error announcements. Continuous animation stops on completion; there
is no JavaScript drawing loop or added animation dependency. Reduced motion shows
the circle and check immediately, with no contraction, orbit, or stroke animation.
Every pill state stays on one line;
errors can expand in width, with the full message available on hover, to screen
readers, and in the main window.

The motion follows continuity, clear feedback and restrained timing while retaining
Linty's own palette and brand. References: [Apple's progress-indicator guidance](https://developer.apple.com/design/human-interface-guidelines/progress-indicators),
[Chrome's expand/collapse discussion](https://developer.chrome.com/blog/performant-expand-and-collapse),
and [web.dev's animation guide](https://web.dev/articles/animations-guide).
Only the small shell animates width to preserve circular corners; its fixed-size
contents use transforms and opacity. Continuous processing uses only rotation.

With Vite running, open `/tests/previews/pill-motion-preview.html` to compare
quiet-room, background-noise, soft-speech, conversation and emphasis presets.
The preview renders the actual capsule, supports input-strength adjustment and
optional local microphone metering, and includes the complete state sequence.
Its drag surface and Reset position control let you try placement as well.

## Placement

Drag the pill background or icon to move it **only during hands-free listening**,
entered by double-pressing a configured trigger. Hold-to-talk, processing and
completion stay fixed. The stop and dismiss buttons retain their click actions. Dragging uses
Tauri's native window move and leaves the typing application focused. The panel
keeps its position between dictations and saves it when hidden for restoration
after relaunch. Placement uses Cocoa screen points across Retina scales; on show,
it is kept inside a connected display's work area, with a bottom-center fallback
if its previous display is no longer connected. No position polling is used.

The surface uses 84% of Linty's own background color with a restrained 18 px blur.
Text and icons stay opaque. Reduced-transparency preferences restore an opaque
surface and remove the blur. The preview's textured background makes this visible.

Neither partial nor final transcript text is sent to or displayed in the pill.
Text still goes to its target application and History as before. The stop button
finishes a recording, and error/empty-stop notices have a dismiss button. Stop
requests and inactivity events include the capture generation, so a queued event
cannot stop a later recording. A new state cancels an older pending fade-out.

## Trigger gestures

The configured modifier or accelerator and the alternate accelerator all use
one gesture interpreter:

- Hold to talk; release to finish.
- Two presses within 400 ms latch hands-free listening. Releasing the second
  press leaves listening on. A small lock beside the elapsed time identifies it.
- Once locked, press either registered trigger **once** to finish and transcribe.
  Stopping happens on the press, without waiting for another press or release.
  An extra tap within 400 ms is consumed so an old double-press habit cannot
  reopen the microphone, even if the previous session finishes immediately.
  Two different triggers cannot combine into an accidental double-press to start.
- OS key repeat does not count as another press. A quick single tap waits only
  for the double-press window; a hold of at least 250 ms stops immediately on
  release. Changing the trigger finishes an active capture.

Latching works while the microphone is opening or the model is preparing.
Recovery, sleep, and a capture timeout clear the gesture state.

## Quiet-input rescue

After **20 seconds without detected input activity**, the pill says “Stopping…”
on one line. A ring around the stop button drains counterclockwise,
with the seconds remaining (for example, “6s”) inside the button; clicking still
finishes dictation. The fixed 24 × 24 px control has a complete circular track behind the shrinking
arc. The number is absolutely centered independently of its one- or two-digit width.
The ring runs continuously without restarting on each second, and reduced motion
shows a static arc updated with the numeral. Input clears the warning. At **30
seconds**, the native audio worker drops the microphone stream before notifying
the frontend. Both held and hands-free recording use this safeguard. Continuous
input has no fixed recording-length limit.

The worker computes RMS and peak over 100 ms frames of the existing 16 kHz
mono audio. A rolling five-second lower envelope estimates steady room noise;
RMS above 1.6 times that floor and peak above 3 times it for two consecutive
frames count as activity. The floor can fall to 0.00001 RMS to preserve quiet
input. Isolated clicks cannot reset the deadline. Checks run every 250 ms while
recording and block on commands while idle; no additional speech model, GPU or
Neural Engine inference is used. Device-opening time is excluded.

These are **input activity measurements, not semantic speech detection**.
Varying background audio can keep capture alive, and sufficiently uniform or
very faint input can be treated as inactivity. The long warning gives a person
time to resume or finish before stopping. Existing ASR/VAD behavior is unchanged;
this guard never crops, normalizes, or removes words from recorded audio.

An auto-stop with detected input transcribes the full recording once. A capture
with no detected input frees its buffer and shows “No input · stopped”, without
calling ASR. Model residency still follows the existing idle-unload preference;
resident models do not continuously perform inference. If the frontend is
unresponsive, the mic is already closed and the existing missing-callback
watchdog subsequently discards the abandoned buffer.

## Validation

- `yarn test`: gesture tests cover modifier and accelerator holds, double presses,
  single-press finishing, extra-tap suppression, repeats, mismatched triggers,
  alternate stopping and recovery.
- `yarn test:dictation` (also `UI_BROWSER=webkit`): configured shortcuts, delayed
  startup, warning/resume, empty stop without ASR, stale events, a single paste,
  no transcript payload, favicon, centered contraction, fast results, interrupted
  transitions, continuous processing, countdown geometry, fading, accessibility,
  locked-only dragging, and the in-app microphone waveform and listener cleanup.
- `node tests/ui.pill-preview.mjs` (also `UI_BROWSER=webkit`): input presets,
  constrained dragging, microphone release and delayed permission cancellation.
- `cargo test --no-default-features --lib capsule::placement_tests`: native
  restoration, invalid coordinates, display removal, and work-area bounds.
- `yarn test:recovery`: microphone errors, cancelled startup, deadlines and late
  inference suppression remain covered.
- `cargo test --features local-stt,parakeet --lib`: native silence, quiet input,
  click rejection and steady-background tests alongside the existing suite.

Input tests use deterministic sample frames and UI tests use injected native
signals. They do not claim physical keyboard/microphone or real-room validation.
