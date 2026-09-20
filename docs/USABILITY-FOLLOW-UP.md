# Usability follow-up — 16 September 2026

## Changes

- Apps retains its sort order and date range when navigating away. Overview retains its own independent date range.
- Dictionary retains both unfinished form fields for the current application session. Successful saves clear the submitted draft; failed saves preserve it. An older asynchronous save cannot erase a newer draft. Unfinished text is not persisted to disk.
- Removed Dictionary's summary metrics. Saved words, their table count, the add form, and suggestions remain.
- Icon actions share a single tooltip implementation: delayed pointer help, immediate keyboard-focus help, bounded placement, hoverable content, Escape dismissal, and cleanup on navigation, scrolling, clicking, disabling, or unmounting. Tooltips inside dialogs remain within the dialog's accessibility tree. Accessible names remain available without opening a tooltip.
- Settings labels now focus their associated fields. The status bar announces complete status messages. The capsule has a persistent live region containing only state changes and errors, so its timer, progress percentages, and streaming transcript do not generate repeated announcements.
- The typing-speed dialog initializes its form before becoming interactive. Saving or rolling back a preference no longer resets the draft or interrupts a retry.

## Browser verification

`npm run build`, `npm test` (22 tests), and the UI, motion, and usability suites were run with Chromium and WebKit. The usability suite is available as `npm run test:usability` (set `UI_BROWSER=webkit` for WebKit).

Coverage includes:

- Navigation away and back with independent ranges, sort selection, and an unfinished Dictionary entry.
- Failed Dictionary writes, successful clearing, and a delayed save completing after a newer draft was entered.
- Tooltip geometry, pointer-to-tooltip movement, focus, Escape, modal ownership, and stale-tooltip removal.
- Increased-contrast accessibility checks on all eight pages in both persisted themes.
- Page and Settings reflow at a 540 × 380 CSS viewport, equivalent to a 1080 × 760 window at 200% page zoom, with the optional sidebar collapsed. This is a viewport-equivalence check, not a claim that macOS text-size preferences were changed.
- Stable capsule announcements while recording time and streaming text change.
- Existing functional and motion coverage: keyboard navigation, dialogs, dropdowns, history, corrections, notifications, reduced motion, both themes, and the minimum window size.

Screenshots and machine-readable results are under `artifacts/usability-chromium`, `artifacts/usability-webkit`, `artifacts/ui`, `artifacts/ui-webkit`, and `artifacts/motion-*`.

## Native macOS verification

The running native Linty app was inspected through macOS Accessibility, with microphone and Accessibility permissions already granted.

- Start/stop microphone controls responded to 100 ms, 250 ms, one-second, and two-second recording attempts. The no-speech path returned to a usable state and displayed its recovery message.
- The repository's existing native engine benchmark executable transcribed a generated 13.6-second WAV with the installed Whisper and Parakeet models. Both returned the expected text. Whisper's first/warm-median inference times were 1,686/1,222 ms; Parakeet's were 157/98 ms. These are observations from this machine and sample, not product-wide performance guarantees.
- During that separate benchmark process, eight native page navigations resolved the expected headings within 159–215 ms, including Accessibility IPC overhead. This checks responsiveness under shared system load; it does not measure compositor frame pacing or prove the complete in-app speech-and-paste pipeline.

Native observations are saved under `artifacts/native-usability`.

## Remaining hands-on validation

VoiceOver was launched, but its automation interface could not return cursor or spoken-output data (macOS errors `-1728` / `-1708`). VoiceOver and its utility were closed afterward. Native accessibility roles and names were inspected, but spoken VoiceOver behavior is **not marked as passed**.

A hands-on pass should still confirm VoiceOver reading and announcement timing, permission revocation/recovery, microphone changes, and a complete spoken dictation into another application. Native frame pacing under the application's own transcription workload also remains a visual/device check.
