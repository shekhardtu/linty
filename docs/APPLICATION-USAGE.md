# Application usage and dashboard metrics

Linty can identify the active macOS application with AppKit’s [`NSWorkspace.frontmostApplication`](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication), which returns the app receiving keyboard events. This is a direct operating-system query; CPU utilization cannot tell us which app a person is using.

## Implemented behavior

- At the start of recording, Rust copies the active app’s display name and bundle identifier into the recording state. The nonactivating capsule is designed to preserve the foreground application.
- The stop result carries that identity alongside the captured audio duration. Successful nonempty transcriptions save it with their final output word count to `~/Library/Application Support/ai.linty.desktop/linty-history.sqlite3`.
- The dashboard groups by bundle identifier (falling back to name), reports words, dictation duration, and completed sessions, and allows sorting by words or duration. Selecting an app searches its name in History.
- This metadata stays local, alongside speech recognition, text cleanup, and history.
- Settings → Privacy & Storage → **Attribute dictations to apps** enables or disables capture for future recordings. It defaults on. Disabling it does not erase existing history.
- Older records and sessions with missing/disabled attribution appear as **Unattributed**. They remain in overall totals; historical app attribution cannot be reconstructed.
- History is kept **until you delete it** by default, with no record-count cap. Settings → Privacy & Storage also offers 30-day, 90-day, and 1-year retention, JSON export, and clear-all. **All time** includes every retained transcription; deleting or expiring records also removes their contribution to statistics. See [Local history storage](HISTORY-STORAGE.md) for migration and persistence details.

## Metric definitions and limits

**Dictation time** is the captured audio duration, not CPU time, processing time, or total time spent using an application. It is attributed to the app active when the recording started. If the user switches apps during recording or transcription, this remains the original app. It is not proof of the destination of a successful paste; generated words count even when an automatic paste fails.

**Words** counts the final transcription output, including any correction or translation. The existing transcription pipeline uses whitespace-separated words, so it is not a linguistic word counter for languages without spaces.

**Average turnaround** averages the time from transcription processing to the paste attempt, including correction when used. **Words per minute** divides total output words by total recorded minutes. These describe performance directly.

**Estimated time saved** compares typing the words from fully timed dictations at an editable typing speed with their recorded speech plus processing time. The initial 40 wpm is a disclosed assumption, not a measured typing speed or population benchmark. The info icon shows that assumption on hover and keyboard focus; clicking opens the breakdown and a locally persisted setting. Editing afterward is not measured or subtracted. Entries lacking positive word count, speech duration, or processing time are excluded from the estimate; the breakdown reports partial coverage. When typing would be quicker, the summary says so instead of clamping the result to a positive saving.

**Personal progress** compares matching 7-day or 30-day local-calendar windows through the same time of day, preserving daylight-saving boundaries. Comparison is omitted if the retained archive does not cover the prior window. Pace changes additionally require at least three timed dictations and a minute of speech in each window. Active days count distinct local calendar dates with saved dictations; All time has no previous-period comparison. All measurements are local and based on retained records, not other users.

**Milestones** recognize saved-word thresholds starting at 1,000, then 2,500, 5,000 and the same sequence at successive powers of ten. The crossing date is derived from chronological retained history. Deletion, expiry and clear-all therefore update or remove the recognition as well. No streak penalties, repeated celebration animation, telemetry or population rankings are involved.

**Local share** measures the fraction of successful saved dictations that used the local speech engine. Older records retain their original attribution; all new dictations are on-device.

The 7-day and 30-day filters use local calendar days including today. Activity charts use the selected period and aggregate longer retained history by month. Empty periods display zeros and empty states.

Browsers are identified as applications (for example, Safari or Chrome), not individual websites. Site-level attribution would require a separate browser integration and its own controls.

## Feasibility of total active-app hours

Tracking total foreground time while Linty runs is also feasible, but is a separate feature from dictation attribution. Use [`NSWorkspace.didActivateApplicationNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification) through the workspace notification center to close the previous app’s interval and open the next one. Avoid CPU/process sampling.

A production implementation should account for idle time, sleep/wake, locked or inactive sessions, app shutdown, and crash recovery. Use monotonic clocks for elapsed intervals and local daily aggregates for persistence. Make background activity tracking a separate explicit setting and provide clear/delete controls. Do not label the elapsed time between two activations as active human usage without handling inactivity.

No continuous activity tracking or site attribution is implemented in this change. Basic app identity uses AppKit; it does not read window contents or request additional screen-recording/automation permissions. Linty’s microphone and accessibility permissions remain necessary for its existing recording and paste features.

## Validation

- `yarn build`: frontend type checking and production build.
- `cargo check --features local-stt` and `cargo check --no-default-features`: native implementation compilation.
- `cargo run --manifest-path src-tauri/Cargo.toml --example app_attribution_probe --no-default-features`: live macOS foreground-app lookup and IPC serialization, without logging app identity.
- `node --test tests/usage.test.mjs` (Node 22.18+): period boundaries, aggregation, application identity, old records, time formatting, and daylight-saving behavior.
- Isolated browser QA uses synthetic fixtures and mocked Tauri IPC, without accessing real local history. Real microphone → native capture → paste attribution still needs a macOS application smoke test.
