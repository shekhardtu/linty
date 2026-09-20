# Native dictation pipeline

Rust owns a dictation from capture through delivery. React captures a configuration snapshot, sends start/stop/cancel requests, and presents progress and the result. Speech models and their inference defaults are unchanged.

```mermaid
flowchart LR
    A[Capture + settings snapshot] --> B[Speech recognition]
    B --> C[Save original to History]
    C --> D[Optional cleanup proposal]
    D --> E[Preservation checks]
    E --> F[Dictionary replacements + checks]
    F --> G[Save finished text]
    G --> H[Single delivery attempt]
    H --> I[Record delivery outcome]
```

## Ownership and recovery

`src-tauri/src/dictation.rs` permits one active session. Settings, dictionary entries, language and the selected model are captured once. The audio generation identifies a session; stale generations cannot attach to its successor. A stop request starts one native worker. Reading its cached result does not repeat recognition or paste. Processing continues if the webview stops waiting. Reloading the UI does not currently reattach its live recording controls; History remains the durable recovery path.

Cancellation invalidates capture and processing. Model preparation, recognition and cleanup have bounded waits. Archive operations have a 20-second wait limit; a blocking disk operation may finish later, but cannot resume a timed-out pipeline or cause paste. Once delivery begins, its owner completes observation and clipboard restoration even after cancellation. Cancellation after posting Cmd+V cannot undo insertion.

The raw transcript is saved before cleanup or delivery. A failed initial save returns the text for copying and skips automatic paste. A failed update before delivery also skips paste. Later pipeline updates cannot recreate a deleted record or overwrite a manual text edit. A crash after recognition and persistence leaves an original transcript with an incomplete delivery status; there is no automatic replay. Audio retention and consent still use the existing archive policy. Filler-only cleanup removes its temporary record without pasting.

`dictation/backend.rs` separates platform operations from sequencing. The same pipeline runs against an in-memory adapter in tests, exercising ordering, cancellation, preservation fallback, storage failure and unverified delivery without a microphone or webview.

## Text preservation

Cleanup and dictionary output are proposals. Shared deterministic checks compare negations, uncertainty words, currency/percentage markers, signs, explicit names and quoted/code/path literals. A rejected cleanup proposal falls back to the raw transcript. Configured dictionary spellings may intentionally change names; they cannot bypass the remaining checks.

Numeric values, weekdays and months are left to the cleanup model. Changes such as “four licences—my bad—five licences” → “five licences”, “two pm” → “2pm”, and “we ship in April, my mistake, January” → “We ship in January” do not trigger rejection on their own. Number words, weekdays and months are excluded from the name check regardless of capitalization. This also allows accidental numeric/calendar changes and changes to personal names that match calendar words, such as April or May. Quoted/code/path literals, signs, units and the other checks remain protected.

These checks do not prove semantic equivalence. They are chiefly English-oriented, miss some harmful paraphrases, and can reject valid edits. Narrow, adjacent, explicit number/name self-corrections are still normalized for the remaining checks, such as negation and currency markers. Cleanup remains opt-in. The [historical comparison](benchmarks/native-pipeline-2026-09-19.md) predates removal of the numeric-value and calendar checks and records both prevented corruption and false rejection.

## Delivery and timing

The delivery module owns clipboard snapshot/publication, checked key posting, bounded Accessibility observation and restoration. Before posting it checks cancellation and the captured destination. For readable controls, confirmation requires the exact expected text after replacing the captured UTF-16 selection. Finding a matching substring or observing a clipboard read is insufficient.

| Stored status | Meaning |
|---|---|
| `pending` | Delivery has not completed; check History and the destination before retrying. |
| `verified` | Exact insertion was observed in the captured field. |
| `unverified` | Cmd+V was posted, but insertion was not confirmed. |
| `failed` | No successful delivery command was recorded. Copy the retained text manually. |
| `skipped` | There was nothing to paste. |
| `pasted` | Legacy record: paste was sent, without the new insertion verification. |

Unsupported or unreadable applications can receive a paste while remaining unverified. Observation waits at most two seconds between bounded Accessibility calls. Slow applications may therefore record an unverified outcome even when they insert successfully. Unverified delivery dismisses the pill quietly without a warning toast or a success signal; verification details remain available in History. A known delivery failure still shows a recovery message. No uncertain delivery is retried automatically. `attemptedText` records a posted payload; new `pastedText` snapshots require verification.

Clipboard restoration respects a new user copy through the pasteboard change count. A generation check and the restoration write share a lock, so an older timer cannot restore over a newer publication. Restoration waits at least 800 ms after posting; this still cannot guarantee clipboard-read timing for every remote or slow application.

Timings use monotonic clocks. History includes audio finalization, remaining preparation, recognition, cleanup, delivery and total processing. `releaseToInsertionMs` is measured from native stop-command entry to observed insertion, not the physical hotkey release. It is absent when insertion is unverified. UI labels make that boundary explicit.

## Release validation

Run native pipeline tests, the frontend command-contract/recovery/gesture checks, and History detail checks. Browser tests cannot validate macOS permission attribution, real audio capture or cross-application insertion. Follow the packaged-app requirement in [CONTRIBUTING.md](../CONTRIBUTING.md), including Finder launch, real recording, TextEdit/browser/editor targets, focus changes, consecutive dictations, cancellation and clipboard preservation.
