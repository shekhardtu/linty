# Interaction and motion audit

Audited on 16 September 2026. Scope: the desktop app's React interface, first-run setup, and the recording capsule. Existing screen compositions and components are preserved; changes concern feedback, transitions, positioning, and transient UI state. The standalone marketing website is outside this desktop-app audit.

## Findings and changes

| Surface | Finding | Resolution |
| --- | --- | --- |
| Clickable controls | Buttons used an arrow, links used a pointer, and copyable transcript rows used a text cursor. | Enabled buttons, icon actions, links, clickable rows, dropdown options, and disclosure summaries use a pointer. Disabled controls use `not-allowed`; editable and selectable text retains its text cursor. Disabled standard controls no longer gain hover or press styling. |
| Shared feedback | Broad `transition-all` rules could animate dimensions; press feedback varied between brightness filters, movement, and 5% scaling. | Shared 100/160/220 ms motion tokens; explicit paint/transform properties; small press feedback on fixed controls. Row hit areas remain stationary. |
| Navigation | The entire main element remounted with a retained transform animation. Scroll positions were discarded. | Keep the main element stable, reveal page content without translation or a fully blank frame, and restore session scroll positions for pages, settings categories, and history queries/pages once data is ready. No width animation during responsive reflow or sidebar visibility changes. |
| Dropdowns | Chevrons and menus snapped; option `scrollIntoView` could scroll ancestors, and pointer navigation could move the list under the cursor. | Chevron transitions, native top-layer entry/exit, retained positioning during interrupted closes, and scrolling confined to the option list for keyboard navigation. Pointer hover never initiates scrolling. |
| Transcript action menus | A menu could remain detached from its source row after scrolling or resizing. | Dismiss the menu when its surrounding pane moves; restore keyboard focus without scrolling. |
| Tooltips | Cursor tracking animated `left` and `top`, queuing layout work and lagging behind the pointer. | Use bounded transform positioning with a brief entrance fade; cursor tracking updates directly. |
| Switches and progress | Switch thumbs animated `left`; download progress animated `width`. | Fixed geometry with thumb translation and progress scale transforms. |
| Overview cards | Cards already shared the tallest grid cell but visibility changed abruptly. | Opacity crossfade with stable card height; inactive cards remain inert. |
| Dialogs | Abrupt opening/closing and changing busy labels could change button width. | Top-layer opacity/transform transitions, matching backdrop fade, stable label geometry, and focus restoration with `preventScroll`. The estimate dialog stays mounted so closing can finish. |
| Notifications and copy | Toasts disappeared immediately; an older copy timer could clear feedback from a more recent click. | Inert toast exits fade and collapse before removal. Repeated copy replaces its feedback timer and cleans it up on unmount. |
| Transcript editor | Adding line breaks changed the textarea's `rows` on every keystroke. | Initial editor height derives from the saved transcript; typing scrolls inside the field, and manual resize remains available. |
| Waveform | Ref values changed every frame but DOM bar heights depended on React rerenders; speed depended on refresh rate. | Paint bar transforms directly at display cadence with elapsed-time smoothing. Capsule waves also use elapsed time and smooth amplitude changes. Reduced motion removes autonomous wave oscillation. |
| Capsule | An untracked exit timer could hide a newly started recording. Recording duration and amplitude could briefly show their previous values. | Cancel pending exits when a new state takes ownership, reset recording values immediately, and reverse exit transitions without replaying entrance. Stable pill height across status changes. |
| Theme and reduced motion | Theme application happened after paint; newer overlay transitions needed complete reduced-motion coverage. | Apply theme before paint; suppress palette interpolation during a theme change; include overlays, backdrops, disclosures, and press effects in reduced-motion rules. A neutral `scale(1)` is deliberately avoided because it changes containing blocks and breaks stretched row actions. |

## Verification

Commands:

```sh
npm run build
npm test
npm run test:ui
UI_BROWSER=webkit UI_PORT=1462 npm run test:ui
npm run test:motion
UI_BROWSER=webkit npm run test:motion
```

The functional suite covers all eight main pages, six settings categories, onboarding, capsule states, both themes, keyboard navigation, focus containment, accessibility checks, a 605-record history archive, search/pagination, clipboard actions, delete/undo, correction flows, storage controls, and the 640 × 480 minimum window.

The dedicated motion suite runs light/dark with normal/reduced motion in Chromium and WebKit. It checks row geometry and hit areas, repeated copy feedback, notification removal, stable carousel height and inert content, bounded tooltips, switch geometry, settings/history scroll restoration, dropdown cancellation/focus/scroll containment, interrupted menu actions, action cursors, accidental layout transitions, minimum-window menus, and the capsule exit/new-recording race. Screenshots are written under `artifacts/motion-chromium` and `artifacts/motion-webkit`.

## Boundaries

Tests use the repository's synthetic Tauri bridge; they do not exercise actual microphone hardware, OS permissions, the native menu's animation, or compositor performance inside the shipped macOS app. A device-level visual pass is still needed to judge those native surfaces and frame pacing under real transcription load.

Native disclosure interpolation and discrete top-layer transitions are progressive enhancements. Older WebKit versions fall back to immediate visibility changes while keeping the controls functional. Sidebar visibility, responsive breakpoints, and opening the History reading pane still make their intended layout change; those dimensions are deliberately not tweened through repeated text reflow. Scroll memory is bounded and session-only. The [usability follow-up](USABILITY-FOLLOW-UP.md) adds session retention for usage periods, Apps sorting, and the unfinished Dictionary form, and records subsequent native validation and its remaining limits.
