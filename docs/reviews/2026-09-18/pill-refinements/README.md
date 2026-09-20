# Dictation pill refinement review

The quiet-input warning stays on one line and says “Stopping…”. Its stop button
keeps a complete circular track around the counterclockwise countdown, with
one- and two-digit seconds centered inside the same 24 × 24 px control. Speaking
clears the warning; clicking the countdown still finishes dictation.

The existing Linty favicon and scrolling waveform follow recent microphone RMS
levels. Quiet and loud input remain distinguishable, silence settles to dots,
and reduced motion keeps the favicon still. Transcript text remains absent from
the pill, and processing and success retain their existing transitions.

Review covered the native quiet-event cadence, countdown lifecycle and reduced
motion, amplitude mapping, generated SVG source, accessibility, and layout in
both themes. A WebKit test timing race was fixed by waiting for React to render
the countdown update before checking it. No blocking review findings remain.

Validation:

- `yarn build`: generated assets, TypeScript and production bundle passed.
- `yarn test`: 73 tests passed.
- `node tests/ui.dictation.mjs`: passed in Chromium.
- `UI_BROWSER=webkit UI_PORT=1467 node tests/ui.dictation.mjs`: passed in WebKit.
- Rust logging hygiene and `git diff --check`: passed.

The browser tests cover configured triggers, quiet-input recovery, stale events,
one paste, no transcript text, geometry, countdown continuity, input modulation,
dismissal, and accessibility in light/dark themes with and without reduced motion.
They use synthetic input and mock Tauri IPC; this review does not include a live
microphone or packaged-app trial.

| State | Light | Dark |
| --- | --- | --- |
| Listening | ![Listening in light mode](listening-light.png) | ![Listening in dark mode](listening-dark.png) |
| Stopping | ![Countdown in light mode](quiet-light.png) | ![Countdown in dark mode](quiet-dark.png) |
