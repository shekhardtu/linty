# One onboarding path

Open [the HTML walkthrough](index.html). It works offline and embeds 13 screenshots. Click a thumbnail to inspect the screen and its next action.

**Welcome → Language → Microphone → Accessibility → Shortcut → Ready → Try dictation.**

English and Right Command are selected for fresh installs. Customers can keep both and click through. Microphone and Accessibility access remain required. Speech support prepares automatically; existing customers keep their saved preferences.

The copy audit removed repeated explanations, shortened permission instructions, moved download details to preparation, and kept three compact shortcut presets. Custom shortcut recording is available in Shortcuts after setup. Ready has one normal action: **Try dictation**, which saves setup and opens System Check.

Recovery and optional selections are collapsed in the walkthrough. They show states inside the same flow, including denied access, download progress and retry, Auto-detect, and a macOS fn conflict.

All six primary screens were checked at 640 × 480: no horizontal overflow, and the visible actions fit without scrolling. On short windows, decorative step icons are hidden to leave space for content. The walkthrough was verified at 1440, 900, and 390 pixels, including every enlarged screenshot, dialog keyboard dismissal and focus restoration.

Screenshots use the local app with simulated macOS permissions and downloads. Native permission dialogs, real speech recognition, and paste into other apps were not exercised by these captures. This is a local review, not a published release.

See [capture manifest and screen copy](screens.json) and [walkthrough checks](verification.json). Local capture/build/check scripts are in `artifacts/onboarding-flow/`.

Final validation: production build, full Chromium interface suite, onboarding/language suites in Chromium and WebKit, and offline legal-notice checks passed. Native macOS permission prompts and real external-app paste remain outside these browser checks.
