# Linty macOS interface redesign

## Audit and intent

Linty's main task happens outside its window: hold a shortcut, speak, release, and continue working in another app. The window should make readiness understandable, help people recover text, and keep configuration easy to find.

The visual direction is **Quiet editorial**: generous type, open reading areas, a cool mineral sidebar, and a small vocabulary of teal rules, sound strokes, and softly asymmetric inset surfaces. Grouping should follow the content. A number, setting, or section does not automatically need a card.

## Information architecture

- Workspace: Overview, History, Apps, Dictionary.
- Utilities: Shortcuts, System Check, Settings, About.
- Settings: Dictation, Audio, Language, Appearance, Privacy & storage. Category selection is retained while navigating; search links to the corresponding category.
- Overview: two columns align at the top. The reading column starts with estimated time saved, words and personal dictation pace beneath it, and recent transcriptions. An info icon reveals the typing assumption on hover/focus and opens its editable calculation on click. Active-day progress sits beneath the activity chart; a saved-word milestone takes the first carousel slot when available. Words/day, dictation by app, and a manual widget carousel occupy the supporting column, followed by a muted history-scope note with typography alone. Widgets show real shortcut and dictionary state and link to the corresponding pages. Their single-line headings scale with the available width, and all slides share the tallest slide's height so navigation never shifts the controls or following content. Narrow windows stack the content.
- Processing: on-device usage and correction rates live in a collapsed disclosure under Privacy & storage. Overview focuses on the user's words and activity.
- Apps: “Words, everywhere” leads with the most used app, total words, and dictation time. A single distribution strip uses the accent for the leading app and neutral tones for the next apps, with an explicit unattributed segment when needed. Sorting only changes the open table, preserving the distribution ranking. The privacy note reflects the actual app-attribution preference and links to its settings.
- Dictionary: a full-width table keeps words and controls together; an open add-word form and a selectively tinted suggestions section follow it.
- History follows the reviewed timeline and selected-transcription compositions. A stable page heading, saved count and full-width archive search sit above date-grouped entries. App icons expose their names on hover and to assistive technology; two-line previews and quiet metadata keep the list scannable. Selection reveals a compact index with a tinted inset and teal edge, alongside larger, selectable reading text. Copy and Edit text are explicit actions; an overflow popover contains Delete with Undo. Processing timings and the original transcription use disclosures, and corrections remain visible below the reading text. Both themes share the same layout. Narrow windows show a full reading pane with a History back action; 50-record pagination and archive-wide search remain available.

## Design system

System font, regular body, medium labels, and tabular numerals for measurements. Larger, lightly weighted headings and a prominent Overview word count establish hierarchy. Supporting controls and metadata remain compact.

The toolbar and sidebar establish the window frame. Workspace, settings and utility pages share the same 1120px maximum content width and 36px outer padding, reduced to 24px in compact windows. A reserved scrollbar gutter keeps their content edges aligned across pages. Settings use 24px section gaps, 16px row padding and 12px form gaps. Container queries respond to the actual page width, including when the sidebar is hidden. Pages remain scrollable at the existing 640 × 480 minimum; wide data tables can scroll within their own section.

Light appearance uses cool porcelain, blue-gray separators and ink text with a dark teal accent. Dark appearance uses layered ink surfaces, cool readable text and a sea-glass accent. The accent marks selected navigation, active period controls, heading rules and recording. Success retains its separate green; warning, error and informational tones are tuned for each appearance. Color roles live in `tokens.css`; the recording capsule and theme previews use the same foundations. The sidebar’s complete sound micrographic scales within a background layer independent of navigation and footer spacing. Its full SVG bounds remain inside the sidebar in short windows, fading smoothly from the bottom toward the top, and controls sit above the non-interactive artwork.

Success, warning, and error pair color with text or symbols. Most content sits directly on the page; the widget, current model, and selected explanatory sections use an inset surface. Repeated sound strokes and short accent rules provide recognition without decorating every component.

Background artwork uses two related motifs: flowing sound lines in Overview, Apps and Shortcuts headers; quieter contours in History, Dictionary, settings and utility introductions. A faint color wash supports the sidebar, and a small contour appears in the Overview widget. Shared line and wash tokens control both appearances. Artwork fades at its edges, stays outside document flow, ignores pointer input and is hidden from assistive technology. Header motifs disappear when their available width is 460 px or less; all decoration is suppressed in forced-color mode. Reading lists, charts and data tables retain plain backgrounds.

## Shared ownership (DRY / SSOT)

| Concern | Source of truth |
| --- | --- |
| Theme palette, semantic colors, page widths | `src/styles/tokens.css`, imported by both main and capsule styles; appearance previews use the same palette |
| Destination labels, titles, descriptions, search keywords, settings categories and navigation types | `src/config/navigation.config.ts`, consumed by sidebar, command search, toolbar and page headers |
| Page shell, page headings and section headings | `src/components/shared/PageLayout.component.tsx` |
| App / installer / tray / web icon geometry | `src/assets/linty-mark.svg`, with platform assets generated by `scripts/generate-icons.mjs`; see [Brand icons](BRAND-ICONS.md) |
| Brand mark and sidebar/setup pattern | `src/components/shared/BrandMark.component.tsx` and `src/styles/brand.css` |
| Subdued background motifs | `BackgroundArtwork.component.tsx`; placement in `brand.css`, motif choice in `navigation.config.ts`, and artwork color roles in `tokens.css` |
| Usage period, clock boundary, totals, app breakdown and chart data | `src/hooks/useUsagePeriod.hook.ts`, using native queries over the complete retained archive and shared local-calendar buckets |
| Usage presentation | Shared `Metric`, `UsagePeriodControl`, `UsageChart` and `HistoryScopeNote` components |
| Cursor-following, edge-bounded overlays | `src/components/shared/FloatingTooltip.component.tsx`, rendered outside chart stacking contexts |
| Payoff estimates, typing baseline validation and comparable calendar periods | `src/lib/payoff.util.ts`; full-history timing and milestone queries in `src-tauri/src/history_db.rs` |
| Clipboard writes and confirmation for transcription rows and copy buttons | `src/lib/transcript-clipboard.util.ts` |
| Dropdowns, selected indicators, typeahead and bounded menus | `src/components/shared/Select.component.tsx` and `src/styles/select.css` |
| Settings rows and selective inset groups | `src/components/shared/SettingsLayout.component.tsx` |
| History persistence, retention and archive-wide aggregates | `src-tauri/src/history_db.rs`; typed IPC in `src/services/history.service.ts` and bounded caches in `history.slice.ts` |

`page-layout.css` owns common layout and page composition rules; `overview.css` owns the Overview composition and `history.css` owns the timeline and reading pane; `apps.css` owns the app-usage composition. `HistorySearch` and `TranscriptDetail` keep History composition separate from querying and pagination; shared row, clipboard and action components retain a single behavior across Overview and History. Feature pages compose these primitives around existing store data and action handlers. Add a new destination in the navigation registry, adjust colors in the token file, and reuse existing usage functions instead of recomputing totals in JSX. Do not create separate per-page palettes or wrap every section in a surface.

## Interaction decisions

Native macOS window controls, menu commands, system permission panels and clipboard behavior stay in use. The React view layer is retained to avoid replacing the recording architecture. A shared toolbar, collapsible sidebar, native Settings menu command, keyboard navigation, visible focus rings, and semantic HTML controls provide consistent desktop behavior.

Overview recent rows copy the full transcription when clicked anywhere outside the separate action buttons, or activated with Enter/Space. Clipboard success and failure use the same feedback as the copy button. Opening the context menu does not copy. History row selection and row actions are sibling elements. Text can be selected normally in the detail pane; copy is explicit. Up/down keys move through records, Command-F searches, Command-C copies a selected record when no text field or text selection owns the command, and Escape dismisses an open action popover, clears search, or closes detail before leaving the page. Narrow windows move focus into the reading pane and restore it to the selected row on return. Delete offers Undo without overwriting newer dictations, with a retry if restoration cannot be saved.

Reset uses a modal HTML dialog with inert background, initial Cancel focus, Escape dismissal, and focus restoration. Operational errors stay visible and updates never claim to be current before a successful check. Dropdowns share a select-only combobox with a bounded top-layer list, checkmarks, a teal selection edge, typeahead, arrow/Home/End navigation, Enter/Space selection, Escape cancellation and light dismissal. Trigger dimensions stay fixed as the menu opens or the choice changes. Settings retain keyboard-operable segmented controls; descriptive labels remain attached to fields.

Changing the usage period preserves the chart's available width. Bars and gaps compress within equal grid tracks; end labels stay inside the plot. The chart tooltip follows the pointer with a short easing transition, stays within visible bounds, and remains above the bars. It also appears on bar focus and dismisses with Escape. Reduced Motion removes the following transition.

Animations last roughly 120–180 ms and communicate state. Reduced Motion suppresses transitions, Increase Contrast strengthens boundaries, and reduced-transparency preferences use solid surfaces. Onboarding uses named steps and scrollable content. The recording capsule keeps its compact overlay role and shares the app's color and motion language.

## References

- https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/
- https://developer.apple.com/design/human-interface-guidelines/toolbars/
- https://developer.apple.com/design/human-interface-guidelines/sidebars/
- https://developer.apple.com/design/human-interface-guidelines/accessibility/

## Validation

Executed checks:

- `yarn build`: strict TypeScript check and Vite production build.
- `yarn test`: 22 usage, payoff, language and correction/dictionary tests (Node 22.6+ for TypeScript stripping).
- `yarn test:ui`: Chromium integration tests and WCAG A/AA automated checks.
- `UI_BROWSER=webkit yarn test:ui`: the same checks in WebKit, including Mac-specific focus handling.

Install test browser binaries with `npx playwright install chromium webkit`. The UI suite starts and stops its own local Vite server. It covers all destinations and preference categories in both themes, the two-column Overview and widget navigation, Processing details using actual fixture totals, period controls, search and category navigation, settings persistence, keyboard copy and selection, deletion/Undo, recoverable update/download errors, modal focus/Cancel, sidebar visibility, every page at the original 640 × 480 minimum, first-run setup, and capsule states. Screenshots are generated under `artifacts/ui/` and `artifacts/ui-webkit/` (ignored by Git).

Browser fixtures use synthetic data and stubbed Tauri commands; they never access application data or audio. Native menu popup rendering, traffic lights, window dragging, real microphone permissions, VoiceOver, and actual dictation/pasting still require a pass in the packaged application.
