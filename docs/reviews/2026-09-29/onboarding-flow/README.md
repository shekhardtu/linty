# Full onboarding review

Open [the standalone HTML walkthrough](index.html). It embeds all 13 app screenshots, works offline, and marks every step and conditional state as **Required** or **Optional**.

The six wizard screens are required on first launch: Welcome → Language → Microphone → Accessibility → Shortcut → Ready. Changing English or Right Command is optional. Completing Ready opens System Check; making a test recording there is optional.

The walkthrough covers permission denial and recovery, speech and English cleanup downloads, interrupted downloads, failed completion saves, unsupported speech builds, Auto-detect and fn conflicts. A table distinguishes mandatory screens from optional choices within them.

Review scope: Merged PR #101 (`473325e`) plus this permission-recovery and parallel-download follow-up. The latter waits for both startup permission checks, restores missing access after reinstall, rechecks access before saving completion, and blocks shortcuts until setup completes. Installer publication is separate from this review.

Screenshots are reused from the PR's September 21 capture; these app screens have not changed visually. Permissions and downloads were simulated. macOS permission prompts and System Settings are described, not reproduced.

Speech support and English text cleanup now start downloading together on Welcome, before any wizard clicks. Both continue while the customer chooses a language and allows permissions. The Ready screen preserves earlier progress and waits for both preparation tasks. A failed transfer can be retried while reusing the other download.
