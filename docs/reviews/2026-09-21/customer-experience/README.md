# Linty customer experience audit

Reviewed 21 September 2026. Baseline: `origin/main` at `e5688ac`; public release at review time: [v0.0.67](https://github.com/shekhardtu/linty/releases/tag/v0.0.67). Improvements are prepared on `audit/customer-experience` and have not been published.

## Recommendation

Keep Linty’s identity: the teal palette, voice mark, restrained typography, light/dark themes, and readable History view work together well. A wholesale visual redesign would have less customer value than improving the first successful dictation and making recovery easier to discover.

The most significant remaining design work is in onboarding, Dictionary, and Privacy & storage. The landing page already explains the basic product well. GitHub needed a clearer customer entrance before its engineering detail.

This is an expert interface and source review, supported by browser checks and synthetic UI tests. It is not a customer research study or a new certification of native dictation accuracy.

## Improvements implemented

| Finding | Customer impact | Change |
|---|---|---|
| Setup ended with “Start Using Linty,” opening an empty Overview | The next useful action was in a different screen | **Try dictation** now finishes setup and opens System Check. **Go to overview** remains a secondary choice. Both wait for language readiness and successful settings persistence. |
| Setup steps replaced the focused button without focusing the new content | Keyboard and screen-reader users lost their place | Added a main landmark and focus on each step’s heading, without a decorative focus outline on noninteractive text. |
| Accessibility could be skipped without explaining the consequence | “Ready” could be mistaken for working shortcuts and automatic paste | Explained that a microphone test is available, but shortcuts and automatic paste still need Accessibility. Clarified the microphone settings path and the need for an editable destination field. |
| Audio settings selected a microphone but did not offer a test | Customers had to discover System Check themselves | Added **Test your microphone** beside the input settings. |
| Audio, Appearance, and Privacy repeated their page names as section headings | Extra headings competed with the actual choices | Removed these duplicate headings while retaining the page headings and meaningful content sections. |
| About linked to GitHub but offered no explicit help entry | Reporting and self-service were hard to find | Added **Get help**, a troubleshooting guide, and help/support/bug search keywords. |
| The website lacked explicit installation steps and paste recovery | Downloading did not fully explain what to do next | Added installer instructions, first-download estimates, missing-text recovery, and a help link. |
| A small caption in the dark Notes demo failed contrast checking | The caption was harder to read | Removed the text opacity reduction and updated the stylesheet content hash. |
| README led with competitor comparisons and benchmark tables | New users had to pass technical detail to reach installation | Moved installation, the app preview, and privacy before a collapsible technical section. Reduced badges from eight to four. |
| README used the old “Settings → Language” path | Instructions disagreed with the app | Updated to **Settings → Dictation** and aligned setup ordering. |
| Bug reports asked customers to identify an engine/model | Reporting a problem required implementation knowledge | Ask for spoken language and destination app; model details are optional. Added the help guide to the issue chooser. |
| Activity labels said “1 dictations” | Small copy defect undermined polish | Added the singular form to chart descriptions and tooltips. |

The new [support guide](../../../../SUPPORT.md) covers installation, permission recovery, microphone selection, missing paste, interrupted preparation, language accuracy, updates, and saved data. It uses existing functionality and does not promise a support response time.

## Screen-by-screen assessment

“Keep” means no substantial redesign is justified by this review. “Refine next” is a recommendation, not an implemented change.

| Surface | Assessment | Decision / next improvement |
|---|---|---|
| Landing page: header and hero | Clear promise, direct download, platform requirements visible; consistent with the app | **Keep.** Avoid adding competing hero actions, counters, or unverified testimonials. |
| Landing page: product screenshots | Real app screens and clearly identified illustrative data establish credibility | **Keep.** Keep captures synchronized when visible layouts change. |
| Landing page: Notes / Email / Code examples | Useful explanation of dictation inside other apps; manual and reduced-motion controls exist | **Fixed contrast.** Consider starting one of the two rotating showcases paused so visitors can read with less movement. |
| Landing page: privacy and useful features | Local processing and opt-in audio saving are explained; no account requirement is clear | **Keep.** Preserve the distinction between app processing and website hosting. |
| Landing page: FAQ, requests, closing, footer | Installation and missing-paste guidance were absent; GitHub request links are clear about public/sign-in behavior | **Added help.** Keep platform requests below the current Mac product story. |
| Website privacy and terms | Generated from the same content as the app | **Keep.** Checked layout/accessibility locally. This review does not revise legal terms or verify hosting retention. |
| Onboarding: Welcome | Branded, readable, notices available before permission requests | **Refined copy and focus.** A shorter introduction now explains the outcome, setup, and network use. |
| Onboarding: language selection | Searchable choice, native names, Auto-detect shortlist, automatic model routing | **Keep mechanics.** Consider letting English users choose “Keep as spoken” before the additional cleanup download. |
| Onboarding: microphone | Permission detection and denied-state recovery exist | **Refined guidance.** Next, consider an explicit **Allow microphone** action after the explanation; currently requesting begins automatically. |
| Onboarding: Accessibility | Automatic status polling and permission recovery exist | **Required in the defaults follow-up.** Enable Accessibility before continuing; the prior skip route has been removed. |
| Onboarding: shortcut selection | Hold and hands-free gestures are explained; custom shortcut selection is supported | **Simplified after review.** Keep fn, Right Command, and Right Option, plus custom capture. Previously saved combinations remain supported and display as Custom. |
| Onboarding: preparation / ready | Retryable downloads and language changes exist; completion previously led to statistics | **Changed primary handoff to a test.** Next, bring the first test closer to this screen and validate paste in a real destination app. |
| Overview: populated / empty | Strong hierarchy for time saved and recent text; estimates are labeled and explained | **Keep.** The empty-state introduction remains useful for people choosing Overview. Fixed singular chart wording. |
| History: list, selected transcript, search, empty states | Strongest everyday screen: readable transcript, copy/edit, contextual details, keyboard behavior | **Keep.** Consider hiding the repeated “No saved audio” message for customers who have never enabled audio saving. |
| History: edit, corrections, audio and details | Actions are separated from reading; save/error feedback and correction history are available | **Keep.** Clarify in a future copy pass that editing History does not replace text already pasted into another app. |
| Apps | Attribution and statistics are honest, but eight columns make the screen feel analytical | **Refine next.** Default to app, words, dictation time, and last used; put secondary timing metrics in details. Retain access from Overview. |
| Dictionary: entries, add, suggestions, empty state | Clear manual-add flow and useful correction suggestions; seven columns and technical counters compete with the words | **Refine next.** Prioritize Word / Heard as / Enabled; make counters and origin secondary. Add inline edit and search when vocabulary grows. |
| Shortcuts | Consistent keycaps, clear gesture instructions, full shortcut reference | **Reduced to three presets plus custom capture.** Separate “Dictation” from “Navigate Linty” in the long reference list in a later pass. |
| System Check and microphone test | Useful recovery destination; permission status and recording results are explained | **Improve discoverability now.** Next, prioritize the recorder when permissions are already granted; at small heights it sits below the permission block. |
| Settings: Dictation | Language-first, technical model choice hidden in Advanced, preparation feedback and a test action | **Keep.** Avoid bringing model selection back into the primary workflow. |
| Settings: Audio | Simple choice, clear default-device behavior, but testing was elsewhere | **Added test action and removed duplicate heading.** The fixed 16 kHz value can move into technical details later. |
| Settings: Appearance | Light / Dark / System previews match the product | **Removed duplicate heading.** Consider dropping the fixed accent-color row because it is not a choice. |
| Settings: Privacy & storage | Important controls are explicit, but history/audio management follows long learning explanations | **Refine next.** Group “History & recordings,” “Personalization,” and “Processing”; move data controls nearer the top without hiding consent information. |
| About: installed, checking, available, error states | Clear version/update grouping and compact release panel | **Keep new layout; added help.** Version `0.0.25` in audit captures is a fixture value, not the current release. |
| Sidebar, search, toolbar, status bar | Stable shared layout and working keyboard search; language status opens the right settings | **Added help search.** Later consider making Apps secondary to Overview and moving setup utilities into a smaller group; no navigation removal in this pass. |
| Recording focus, capsule, silence/error feedback | Compact brand-consistent feedback; recording and processing are distinguishable | **Keep.** Existing interface tests cover the overlay states; actual native placement remains a manual check. |
| Update-required, update notice, reset, delete and retention dialogs | Clear consequences, focus handling, busy states, and recovery controls | **Keep.** Interface tests cover these states; this review did not install an update or delete real data. |
| Native menu bar and macOS menus | Source includes microphone/language switching, copy-last, recent text, History, Settings and quit protection during work | **Keep based on source review.** No fresh native screenshot or VoiceOver test of macOS menus was performed. |

## GitHub presentation

Verified the public repository metadata and latest release through GitHub’s API/CLI. The description, homepage, relevant topics, enabled Discussions, MIT license, contributor guide, security reporting, issue forms, PR template, and customer-facing release notes are present. The currently open public issues at review time were the Windows and Linux platform requests linked by the website.

The README now starts with getting the product running. The comparison and benchmark evidence is retained for interested readers, including its existing dates, methodology, and limitations; it was not re-benchmarked or independently revalidated in this audit.

Suggested repository follow-ups:

- Consider a custom social preview using an actual app screenshot and a short product promise. No new logo is needed.
- Add community conduct expectations when outside contribution volume warrants them. GitHub reports no code of conduct; this is not an installation blocker.
- Keep release notes focused on customer changes and keep the pinned download path stable.
- Merge the support guide before publishing an app or website that links to it. Publish the updated setup wording alongside the corresponding app version.

No repository settings, issues, discussions, releases, or branch protection were changed during this audit.

## Prioritized next design pass

| Priority | Work | Acceptance condition |
|---|---|---|
| P1 — first-use friction | User-controlled permission requests and predictable backward navigation | A first-time user can read the reason, initiate the request, deny/retry, return from System Settings, and change the language without getting trapped in auto-advancing steps. Validate on a clean macOS account. |
| P1 — first success | Guided recording followed by a real paste trial | Setup ends with understandable feedback for speech, no speech, missing permission, failed preparation, and unsuccessful delivery. A user can recover their words from History. |
| P2 — information hierarchy | Simplify Dictionary and Apps tables | Everyday actions fit in the default view at the minimum window size. Secondary statistics remain available without dominating the page. |
| P2 — privacy navigation | Group history/audio controls before learning detail | A customer can find retention, export, and deletion without reading the full dictionary explanation; opt-in consequences remain adjacent to their controls. |
| P2 — motion and density | Reduce simultaneous website motion and redundant informational rows | The product is understandable with motion off, and decorative or fixed-value rows do not resemble configurable settings. |
| Verification follow-up | Recheck website hosting behavior described in `website/README.md` | Verify current host injection and retention settings directly. Source guards alone do not establish hosting behavior. A direct HTTP inspection returned 403 in this session; the public page was readable in the browser. |

These priorities reflect observed friction and expert judgment. Validate them with a few first-time users before undertaking a broad navigation redesign. Useful observed tasks: install unaided, dictate the first sentence, recover a failed paste, add a name, and delete a saved transcript. Measure task success and hesitation in a moderated session; adding product telemetry is not required.

## Verification and evidence

- Production build, generated icon/theme consistency, and legal document consistency checks passed.
- All **151 unit tests** passed.
- The full Chromium interface suite passed before and after the changes: both themes, all app routes, minimum window, a 605-record archive, search/pagination, deletion/undo, correction flows, modal focus, export/retention, onboarding, and required-update states.
- The onboarding/language suite passed in **Chromium and WebKit**, including both completion destinations, failed setup-save recovery, download failure/retry, model caching, language changes, recording safety, and unsupported speech builds.
- Offline legal-notice access, focus restoration, minimum-window behavior, and notice availability before microphone permission passed.
- A focused audit captures all main routes/settings in both themes at 1080 × 760; all six setup steps in both themes at 640 × 480; the landing page at 390, 768, and 1440 pixels; and legal pages at 390 and 1440 pixels. Captures use synthetic data only.
- All **50 captures** completed with no detected horizontal overflow on the checked app/web surfaces, no axe A/AA violations on the checked onboarding/web surfaces, and no page errors. App route accessibility is covered by the separate full interface suite. See [structured results](audit-results.json).
- Screenshot evidence and the structured audit results are in this directory; the full local capture set and audit runner are in `artifacts/customer-audit/`.

Automated accessibility checks are scoped to WCAG A/AA rules covered by axe. They do not substitute for native VoiceOver testing. Native microphone permission prompts, real audio recognition, clipboard delivery to external apps, signed installation, hardware variations, and updater installation were not exercised with real user data in this design pass.

### Selected screenshots

| Change | Light | Dark |
|---|---|---|
| Setup completion at minimum size | [Light](onboarding-ready-light.png) | [Dark](onboarding-ready-dark.png) |
| Audio settings and test entry | [Light](audio-light.png) | [Dark](audio-dark.png) |
| About and help | [Light](about-light.png) | [Dark](about-dark.png) |
| Landing page on a narrow screen | [Light](website-390-light.png) | [Dark](website-390-dark.png) |

### Shortcut simplification follow-up

Reduced the shared onboarding/Shortcuts picker to fn, Right Command, Right Option, and custom capture. Existing saved combinations still display as Custom and continue working. Production build and the Chromium dictation suite passed, including configured combinations and the alternate shortcut. [Light screenshot](shortcuts-light.png) · [Dark screenshot](shortcuts-dark.png).

### Defaults and required onboarding follow-up

Fresh installs start with English and Right Command. There is one six-screen flow: Welcome → Language → Microphone → Accessibility → Shortcut → Ready. Customers can keep the selections and click through. Both permissions and successful preparation remain required; saved customer choices are preserved.

A second copy audit shortened every primary screen. Welcome keeps one benefit and short privacy/setup notes. Language no longer repeats download details. Permissions each explain their purpose and the next action once. Shortcut shows three compact presets; custom recording remains available in Shortcuts after setup. Ready shows the selected language and shortcut, with one normal action: Try dictation. Recovery actions appear only when needed.

The [HTML onboarding walkthrough](../onboarding-flow/index.html) contains 13 current screenshots, including the six screens, the recording-test destination, preparation, recovery, Auto-detect, and fn conflicts. Recovery and optional states are collapsed so the main flow stays clear. These are actual local UI captures with simulated permissions and downloads, not native macOS permission screenshots.

At 640 × 480, all six primary screens fit horizontally and their actions are visible without scrolling. Short windows hide decorative step icons. The walkthrough checks desktop, tablet and mobile widths, image decoding, all enlargement controls, Escape dismissal, focus restoration and offline operation. Changes remain local and unpublished.

Final validation: production build, full Chromium interface suite, onboarding/language suites in Chromium and WebKit, and offline legal-notice checks passed. Native macOS permission prompts and real external-app paste remain outside these browser checks.
