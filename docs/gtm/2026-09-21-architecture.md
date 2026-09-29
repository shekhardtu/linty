# Linty architecture

Technical explanation prepared 21 September 2026. The runtime description is anchored to committed source revision `e5688ac41af303cb92d558a0dd65bffff848c59c`, the same baseline used for the GTM research. This explains the implementation, rather than claiming a new packaged-app validation. Work in progress, including changes to Mac architecture support, is outside this snapshot. The maintainer's local release policy is described separately in the release section.

## The system at a glance

Linty is a macOS desktop application that turns a microphone recording into text and inserts it into another application. Its interface is built with React and TypeScript, hosted in Tauri 2 webviews. Rust owns the native work: capture, model preparation, speech recognition, optional cleanup, storage, and delivery. A small Swift bridge makes the FluidAudio/Core ML speech engine available to Rust.

The important boundary is **presentation versus ownership**. React asks for a dictation and shows its progress. A native coordinator owns the resulting work and its side effects. The app does not send a recording to a Linty transcription server. Downloads and update checks use the network; speech recognition and text cleanup use installed models on the Mac.

<figure class="architecture-map" aria-labelledby="system-map-caption">
<div class="map-boundary"><p class="map-label">Inside the installed Mac application</p>
<div class="map-pair"><div class="map-node"><strong>Main window</strong><span>React · TypeScript · Zustand<br />Settings, History, Dictionary, Overview</span></div><div class="map-node"><strong>Recording capsule</strong><span>Separate React webview<br />Native nonactivating NSPanel</span></div></div>
<p class="map-arrow">↕ Tauri commands and events</p>
<div class="map-node map-owner"><strong>Rust native coordinator</strong><span>One active dictation · configuration snapshot · generation identity<br />Capture → recognize → save → transform → save → deliver</span></div>
<div class="map-branches"><div class="map-node"><strong>Local inference</strong><span>Whisper / whisper-rs<br />Parakeet / Swift / FluidAudio<br />S1-mini / Candle</span></div><div class="map-node"><strong>Local persistence</strong><span>SQLite history + optional audio<br />JSON settings + dictionary<br />Downloaded models + local logs</span></div><div class="map-node"><strong>macOS integration</strong><span>Microphone and hotkeys<br />Accessibility and clipboard<br />Menu bar, windows, notifications</span></div></div>
</div>
<div class="map-external"><strong>Outside the app</strong><span>Model hosts and GitHub supply downloads and updates. The destination app receives pasted text and applies its own storage or sync behavior.</span></div>
<figcaption id="system-map-caption">A logical component map. Arrows represent local coordination; the webviews are not calling a hosted Linty API.</figcaption>
</figure>

The product baseline is Apple Silicon on macOS 14 or later. Parakeet is specifically gated to supported Apple Silicon hardware and a build containing its bridge. An available Whisper backend is not, by itself, proof that a particular Intel package has been built, signed, tested, and released.

Sources: [app entry and native command registration](src-tauri/src/lib.rs), [window configuration](src-tauri/tauri.conf.json), [frontend entry](src/App.tsx), [native state](src-tauri/src/state.rs), [Swift package](src-tauri/swift/Package.swift).

## Interface, state, and native boundaries

The main window contains onboarding, dictation settings, the transcript archive, the personal dictionary, local usage views, troubleshooting, and About. `App.tsx` composes these screens and starts the hooks that synchronize settings, hotkeys, models, the tray, and updates. Vite builds the frontend assets; the application packages them with the native executable.

Zustand holds the interface's working state in slices: recording, transcription, settings, navigation, history, dictionary, updates, workspace, and toasts. It is a presentation cache, not the authoritative transcript database. Services coordinate persistence and shared operations so different screens do not start independent downloads or overwrite settings without coordination.

The capsule has its own entry point and React component. On macOS it sits in an NSPanel configured not to take focus from the app receiving dictation. Its recording, preparation, progress, and recovery messages come from events. Closing the main window leaves the menu-bar app available; quitting Linty ends the process and its background work.

| Boundary | What crosses it | Who owns the result |
|---|---|---|
| Main webview → native commands | Start/stop requests, captured settings, model choices, archive queries | Rust validates and performs the operation |
| Native → main webview | Recording generation, stage events, results, archive-change notifications | React presents the result and refreshes its cache |
| Native → capsule | State, generation, progress, and correction feedback | The capsule displays feedback without owning inference |
| Rust → Swift | Audio samples, model paths, vocabulary requests, opaque engine handles | The native adapter manages lifetime and blocking work |
| Native → macOS | Audio capture, focus checks, clipboard publication, key posting | The OS and destination application determine whether insertion succeeds |

The command surface is permissioned per window. The main window can manage models and history; the capsule has a much smaller native command list. The app's Content Security Policy restricts webview connections to the application and Tauri IPC. This limits the webview; it does not prevent approved native Rust code from downloading models or updates.

Sources: [state slices](src/store/app.store.ts), [recording hook](src/hooks/useRecording.hook.ts), [transcription presentation](src/hooks/useTranscription.hook.ts), [capsule entry](src/capsule-main.tsx), [capsule implementation](src-tauri/src/capsule.rs), [window capabilities](src-tauri/capabilities/default.json), [command permissions](src-tauri/permissions/application.toml).

## One dictation, from keypress to insertion

The core pipeline is intentionally ordered. A successful speech result is persisted before cleanup, and the finished text is persisted before automatic delivery. This creates a recovery path when a later step fails.

<ol class="pipeline-map" aria-label="Dictation processing order">
<li><strong>Capture</strong><span>Snapshot settings<br />Open microphone</span></li>
<li><strong>Recognize</strong><span>Finish preparation<br />Run local speech model</span></li>
<li><strong>Save original</strong><span>Persist raw text<br />Delivery: pending</span></li>
<li><strong>Transform</strong><span>Optional cleanup<br />Validation + dictionary</span></li>
<li><strong>Save final</strong><span>Persist finished text<br />Preserve original</span></li>
<li><strong>Deliver once</strong><span>Paste and observe<br />Record the outcome</span></li>
</ol>

### 1. Capture the user's choices once

The trigger hook translates key gestures into recording actions. Before `start_dictation`, the frontend builds a snapshot containing the speech model, selected language, allowed auto-detect languages, dictionary entries, cleanup settings, and the correction-observation and app-attribution preferences. Changing settings halfway through a dictation affects a later session.

The native coordinator reserves one session. A recording generation identifies its audio and events. Stale callbacks and cancelled results cannot attach to the next recording. An overlapping start is rejected rather than creating a second independent paste pipeline.

### 2. Open the microphone and prepare in parallel

A dedicated native thread owns the CPAL audio stream. The recording indicator follows successful device opening, rather than just the button press. Device-channel samples are mixed and resampled into 16 kHz mono floating-point audio. Samples remain in native memory; they are not encoded as a temporary WAV and sent through JavaScript for recognition.

Capture starts without waiting for model warm-up. Native preparation can overlap the time the user spends speaking. When recording stops, the stream is closed and the captured samples remain available while processing waits for readiness. This moves some waiting out of the release-to-result interval; it does not eliminate model-loading work.

### 3. Recognize and save the original

`stop_dictation` starts the native processing worker once. `dictation_result` waits for that session's cached outcome; reading it again does not repeat recognition or paste. The selected engine produces text. Empty or blank-audio results end quietly.

For a nonempty result, the pipeline creates a transcript with `rawText`, timing and model metadata, and a `pending` delivery status. If this first save fails, automatic paste is skipped and the text is returned for manual copying. A UI refresh failure is different from a failed database write: saved history remains recoverable.

### 4. Propose changes, then validate them

When enabled and applicable, S1-mini proposes cleaned-up English text. Deterministic preservation checks compare the proposal with the original; a rejected or incomplete result falls back to the original. Dictionary replacements then run with their own validation. User-approved spellings can intentionally change a name, without bypassing the other checks.

### 5. Save the final text and attempt delivery

The finished text and transformation metadata are saved before any automatic paste. If that update fails, the pipeline again skips automatic delivery. A concurrent manual edit or deletion cannot be overwritten or recreated by a late pipeline update.

Delivery owns the clipboard snapshot, publication, focus checks, one key-posting attempt, insertion observation, and restoration. Its outcome is written back to History. There is no automatic repeat of an uncertain paste.

Sources: [configuration snapshot](src/services/dictation-options.service.ts), [native coordinator and pipeline](src-tauri/src/dictation.rs), [platform adapter](src-tauri/src/dictation/backend.rs), [audio thread](src-tauri/src/audio.rs), [pipeline design](docs/DICTATION-PIPELINE.md).

## Speech engines and model lifecycle

Linty integrates existing model families rather than training its own speech foundation model. Language selection is mapped to a compatible model from the native catalog. Supported Parakeet languages prefer Parakeet when available; other languages and Auto-detect use Whisper. Explicit language selection bypasses automatic language guessing.

| Component | Role and runtime | Important boundary |
|---|---|---|
| Whisper Large v3 Turbo Q5 | Speech recognition through `whisper-rs` / whisper.cpp, with Metal acceleration in the baseline Mac build | The selected artifact is about 574 MB; dictionary terms can contribute to a vocabulary prompt |
| Parakeet TDT v3 | Speech recognition through a Rust C ABI wrapper, a Swift bridge, FluidAudio, and Core ML | Apple Silicon capability gate; speech bundle estimate about 500 MB; supported language subset |
| Silero speech-presence detector | A cached local detector on the Parakeet path | Suppresses some no-speech hallucinations; it is separate from the microphone inactivity safeguard |
| Parakeet CTC vocabulary support | Optional local keyword spotting/rescoring using additional CTC assets | Helps integrate enabled vocabulary; it is not an unrestricted text prompt or model fine-tuning |
| S1-mini | Optional English text cleanup through Candle | A separate model and tokenizer, about 496 MB combined; consumes transcript text, not audio |

The Swift bridge is compiled as a static library and linked into the app. It exposes a small C-compatible interface for checking support, downloading, loading, preparing, transcribing, and freeing resources. FluidAudio uses async operations; the bridge waits for them on the calling worker thread. Rust must call these blocking entry points away from the main thread. Opaque handles and returned strings have explicit release functions.

### Downloaded, loaded, and ready are different states

The language-preparation service shares downloads and serializes activation. Only the latest confirmed language request may commit its settings/model pair. Downloading can continue during an active dictation, but changing the active model waits for that dictation to finish. Failed preparation preserves the previous confirmed choice.

Readiness includes actual preparation inference: synthetic silence for speech paths, a warmed speech-presence detector, applicable vocabulary preparation, and installed S1 preparation for English or Auto-detect. Synthetic output is discarded. This avoids calling a model ready merely because its weight file exists. Installed S1 can stay prepared even while cleanup is disabled; warming it does not itself download or enable it.

Only one main speech engine is selected and resident at a time. Locks serialize model loads; reference-counted handles keep in-flight work valid. The idle watchdog can release speech and cleanup models, with a baseline default of 15 minutes. A later dictation reloads and prepares them. Cached files stay on disk when runtime memory is released.

Auto-detect uses a saved shortlist of one to three languages. With one candidate it skips detection; with multiple candidates Whisper's probabilities choose among them before transcription. It does not infer a language from the user's location or IP address. Short or noisy speech can still be misclassified.

Whisper and S1 downloads use pinned artifacts with expected sizes and SHA-256 checks before completed files are accepted. Model identifiers and paths are validated natively, including rejection of symlinks in the supported model storage paths. Parakeet bundle handling is delegated to FluidAudio; do not assume it has the identical verification contract as the individually pinned Whisper/S1 files.

Sources: [language routing](src/lib/languages.util.ts), [shared language preparation](src/services/language-preparation.service.ts), [speech runtime and catalog](src-tauri/src/transcribe.rs), [model storage checks](src-tauri/src/model_store.rs), [Rust Parakeet adapter](src-tauri/src/parakeet.rs), [Swift bridge](src-tauri/swift/Sources/LintyParakeet/Bridge.swift), [readiness details](docs/DICTATION-READINESS.md).

## Cleanup, dictionary, and learning

These are three distinct mechanisms. **Speech recognition** turns audio into text. **Cleanup** asks a local language model to normalize that text. **The dictionary** stores preferred spellings and replacements. “Learning a correction” updates dictionary data; it does not train the speech model or send feedback to a cloud training service.

S1-mini is provided by Superwhisper and runs through Candle with Metal when available and a CPU fallback. Controls select writing style, layout, and lists. The result is plain text. Automatic email layout uses recognized Mail/Outlook/Spark application identifiers when app attribution is available; it does not read a conversation or project and pass that context to S1.

Cleanup is English-only in this integration. Explicit non-English languages skip it; Auto-detect requires sufficiently confident English text. The base setting starts disabled, while the guided English setup can explicitly prepare and enable it. This distinction matters when describing onboarding defaults.

Long inputs are processed in bounded chunks. Timeout, truncation, an incomplete chunk, or rejected output preserves the complete original. Per-request model caches are cleared; transcripts are not retained as a continuing conversation. A filler-only result can disappear quietly without pasting an empty string.

Preservation checks cover details such as negation, uncertainty, currency/percentage markers, signs, names, and quoted/code/path literals. They do **not** prove semantic equivalence. Numeric values and calendar words are deliberately not protected on their own in this revision, which permits useful spoken corrections but also leaves room for unwanted changes. Both false acceptance and false rejection remain possible.

### Optional correction observation

When enabled, a native Accessibility watcher binds a readable editable field and its selection around insertion. It tracks bounded, verified edits to the dictated span. A settled focus departure, or a verified submission followed by field clearing/replacement, can finish the session. Return alone is not enough because it can mean a newline.

The native diff sends changed pairs and metadata to a conservative local classifier. The dictionary service serializes a batch save and supports Undo. Feedback is shown only after saving succeeds. Dictionary persistence and History correction records are separate stores, so the operation is not one transaction across both.

This is limited application coverage. Unreadable terminals, unsupported text protocols, ambiguous insertion, stale edits, large rewrites, and composition can result in no learned correction. Field text is bounded and transient in the native observer; it is not a general keylogger, screen recorder, or continuous document index.

Sources: [cleanup runtime](src-tauri/src/reformat.rs), [text validation](src-tauri/src/text_validation.rs), [dictionary application](src-tauri/src/dictation/dictionary.rs), [correction session](src-tauri/src/corrections/session.rs), [classifier](src/lib/correction-classifier.ts), [dictionary persistence](src/services/dictionary.service.ts), [coverage and limits](docs/CORRECTION-CAPTURE-IMPLEMENTATION.md), [model attribution](src-tauri/licenses/MODELS.md).

## History, audio, and local metrics

The archive is a SQLite database managed by Rust through `rusqlite`. It lives under `~/Library/Application Support/ai.linty.desktop/`. Native commands run disk work on blocking workers. The frontend queries pages and summaries instead of reading the entire archive into its state store.

| Data | Storage and lifetime | Why it is separate |
|---|---|---|
| Transcripts, correction records, delivery metadata | `linty-history.sqlite3`; until deletion by default, or selected retention | Durable recovery and queryable history |
| Optional recordings | WAV blobs in the same database, linked to transcript IDs | Audio retention has its own explicit consent and deletion controls |
| Settings | `linty-settings.json` through Tauri's store plugin | Preferences outlive individual transcript deletion |
| Dictionary | `linty-dictionary.json` through the store plugin | Preferred terms and suggestions are independent of one recording |
| Models | `models/` under application support | Reusable downloaded assets, distinct from resident inference memory |
| Diagnostics | Rotating `~/Library/Logs/ai.linty.desktop/linty.log` files | Local operational information; transcript/clipboard content is excluded by logging policy |

New transcript records distinguish the original `rawText`, accepted `reformattedText` when present, editable `finalText`, `attemptedText` when the paste command was posted, and `pastedText` when insertion was verified. Older records have legacy semantics; a historical `pasted` status does not prove observed insertion.

SQLite writes are transactional, with full synchronization, a rollback journal, and secure deletion enabled. The old history/corrections JSON stores migrate together and are cleaned up after a committed import. A failed migration preserves its inputs. Downgrading the binary does not roll the database format back.

History defaults to 50 records per page; native queries cap a page at 100. The recent-record cache holds 20 entries, while aggregate queries cover all retained history. Deletion and expiry change the totals. “All time” therefore means all retained records, not a separate lifetime usage counter.

### Audio is transient unless saving was enabled

Saving audio is off by default. Consent is captured at recording start and checked again when saving. An epoch invalidates in-flight retention after revocation or bulk deletion; switching saving off and on cannot retroactively authorize an earlier recording.

Inference and optional archive storage share the same reference-counted sample allocation. A blocking worker encodes 16 kHz mono PCM16 WAV directly into an SQLite blob with a bounded scratch buffer. No temporary recording file is required. Audio and text commit together. Deleting a transcript cascades to its audio; Undo restores text and corrections, not the deleted recording.

Selected-record playback is loaded on demand and begins only on Play. The in-app playback limit is 64 MiB; larger saved recordings can be exported. JSON history export excludes audio bytes. Exported files and OS backups have their own lifecycle, outside Linty's deletion controls. The archive is not separately encrypted by Linty.

Optional retention runs at most once every 24 hours while the app is running, including with its window hidden. It installs no system daemon and cannot wake the Mac. Choosing a new retention period performs an immediate confirmed cleanup; scheduled expiry can wait until the next run or launch.

Overview and Apps calculate usage locally from retained transcripts. App attribution records the foreground application's name and bundle ID at capture start; it is not continuous time tracking or website-level tracking. Estimated time saved uses a disclosed, editable typing-speed assumption and excludes later editing time, so it is not a measured productivity guarantee.

Sources: [database implementation](src-tauri/src/history_db.rs), [archive commands](src-tauri/src/history.rs), [storage design](docs/HISTORY-STORAGE.md), [audio lifecycle](docs/AUDIO-PRIVACY.md), [settings store](src/services/settings-store.service.ts), [metric definitions](docs/APPLICATION-USAGE.md), [logging policy](src-tauri/src/logging.rs).

## macOS integration and delivery guarantees

Microphone permission allows capture. Accessibility access supports global modifier monitoring, checked key posting, and reading supported destination fields for verification/correction observation. The app also uses AppKit for foreground application identity, native menus, window behavior, and the menu-bar tray.

The microphone preference is native and shared by Settings, the tray, and capture. Device names come from CPAL. If an explicitly selected device disappears, recording fails rather than silently using a different microphone. Duplicate names cannot be reliably distinguished by this API; System Default remains the alternative.

### A posted paste is not always a verified insertion

Before posting Cmd+V, delivery checks cancellation and the captured destination. For readable controls, it compares the expected field after replacement of the captured UTF-16 selection with an observed value. A matching substring somewhere in the document is insufficient evidence.

| Delivery status | What it establishes | Recovery behavior |
|---|---|---|
| `pending` | No completed delivery result has been saved | Inspect History and the destination before retrying |
| `verified` | The exact expected insertion was observed | A success indication is justified |
| `unverified` | The paste command was posted, but insertion was not confirmed | Keep the text; do not repeat automatically |
| `failed` | No successful delivery command was recorded | Offer manual copying of the retained text |
| `skipped` | No text needed delivery | Finish without changing the clipboard |

Insertion observation is bounded, so a slow or unreadable application can receive text while the record remains unverified. Clipboard restoration respects a newer user copy using pasteboard change counts, and generation checks prevent an old restoration timer from overwriting a newer publication. It waits at least 800 ms after posting, but cannot guarantee clipboard-read timing in every remote or slow application.

App attribution at recording start and the actual delivery target are different concepts. Focus can change while the user speaks. The delivery layer's own target checks determine whether it may post; an Apps dashboard entry is not proof of where text was ultimately inserted.

Sources: [delivery owner](src-tauri/src/delivery.rs), [clipboard handling](src-tauri/src/clipboard.rs), [checked key posting](src-tauri/src/paste.rs), [Accessibility adapter](src-tauri/src/corrections/accessibility.rs), [microphone selection](src-tauri/src/audio_input.rs), [modifier monitoring](src-tauri/src/fnkey.rs), [permissions](src-tauri/src/permissions.rs).

## Privacy and network boundaries

There is no hosted Linty inference or account service in this runtime. The important network boundary is **model/update acquisition versus processing user content**.

| Activity | Where it happens | What to expect |
|---|---|---|
| Recording, recognition, cleanup, dictionary application | On the Mac | Installed models process audio/text locally |
| History, local metrics, optional audio | On the Mac | User-controlled retention and export; no app usage telemetry pipeline |
| Speech/cleanup model installation | Native download code and upstream model hosts | Network access and normal connection metadata are required |
| Update checks and archive downloads | GitHub Releases and its delivery infrastructure | The updater requests release metadata and signed application assets |
| Opening external links | The user's browser | The visited service applies its own data practices |
| Pasting into another app | Clipboard/OS, then the destination | That app can store or sync the pasted text under its own rules |

“Offline after setup” describes dictation with the required local assets installed. It does not mean the entire application never opens a network connection. Local storage also does not replace device security, disk encryption, or backup controls.

The static `website/` is a separate publication surface, hosted independently from the desktop runtime. The Mac app does not require a running website to perform local inference. Website hosting, GitHub download counters, and local app usage are separate systems; download counts cannot identify unique installations or retained users. This architecture page inherits the GTM area's indexing opt-outs, but those are crawler requests rather than authentication.

Sources: [privacy notice](PRIVACY.md), [model downloads](src-tauri/src/transcribe.rs), [cleanup downloads](src-tauri/src/reformat.rs), [native updater](src-tauri/src/updater.rs), [website notes](website/README.md).

## Concurrency, failure recovery, and limits

The native coordinator keeps one active dictation with a configuration snapshot, phase, cancellation flag, generation, and cached result. Audio capture has a dedicated thread. Blocking inference, Swift bridge calls, and disk operations run away from the UI; Tokio coordinates asynchronous waits. Locks and reference-counted handles protect shared models and recording buffers.

| Failure or race | Implemented response | Remaining boundary |
|---|---|---|
| Model preparation still running at stop | Close the microphone, keep samples, wait for shared readiness | Cold setup and compilation can still take time |
| Microphone disconnect or missing callbacks | Cancel/reset capture; a later recording opens a fresh stream | Quiet input and missing device callbacks are different conditions |
| Preparation/recognition/cleanup timeout | Abandon or fall back according to the stage, invalidate late results | A timeout cannot forcibly unwind an arbitrary native hang |
| Initial or pre-delivery storage failure | Return text for copying and skip automatic paste | Unsaved text is not durable over a crash |
| Cancellation during processing | Prevent later processing results from starting delivery | Cancellation after Cmd+V cannot undo an insertion already posted |
| Webview stops waiting | Native processing can finish and preserve history | Reloaded UI does not currently reattach live recording controls |
| Process crashes after saving the original | Original transcript remains with an incomplete outcome | No automatic replay; unfinished in-memory audio is lost |

Preparation has a three-minute guard. Recognition allows at least 60 seconds, scaling with recording duration. Cleanup and archive operations also have bounded waits; archive waiting is capped at 20 seconds. A timed-out blocking write may finish later, but cannot resume the abandoned pipeline and trigger paste.

The audio watchdog distinguishes a dead stream from ordinary silence: missing callbacks for eight seconds trigger recovery. A separate quiet-input safeguard warns after 20 seconds without input activity and closes capture at 30 seconds. It does not run continuous speech inference just to keep the microphone alive.

The current inference runtime is not isolated inside a killable helper process. An external development supervisor exists for bounded crash restarts, but is not a bundled production recovery service. Hard-hang isolation would require a separate process and heartbeat design. These limits matter when interpreting a responsive UI or a passing mocked test as evidence of native reliability.

Sources: [coordinator](src-tauri/src/dictation.rs), [shared state](src-tauri/src/state.rs), [watchdog](src-tauri/src/watchdog.rs), [quiet-input policy](src-tauri/src/input_activity.rs), [frontend recovery](src/services/dictation-recovery.service.ts), [recovery limits](docs/DICTATION-RECOVERY.md).

## Build, release, and verification

Vite compiles the React/TypeScript interface. Cargo compiles the Rust host and enabled inference backends. With the `parakeet` feature, `build.rs` builds and links the Swift package containing the FluidAudio bridge and its required Apple frameworks. Tauri packages the native host, frontend assets, capabilities, icons, and application metadata. Large model weights are acquired during setup rather than included in the small installer.

The maintainer's current release policy is local: use synchronized `main`, perform checks and builds on the maintainer Mac, sign and notarize the application, and publish release assets to GitHub. The native app's updater uses the Tauri updater plugin's signed archive resource. An embedded public key verifies the update artifact; Apple signing/notarization and updater signature verification are distinct checks. This page does not initiate a release.

GitHub's `latest.json` supplies version information and may contain `minimum_version`. The app checks at launch, on its periodic schedule, and after wake. A required update downloads and waits for a quiet dictation interval before installation and restart; an optional update is offered for the user to install. The minimum-version policy field is not itself the archive signature. It can request the latest release, but does not remove the requirement to verify the downloaded artifact.

### What each test layer proves

| Layer | Useful evidence | What it cannot establish alone |
|---|---|---|
| TypeScript/unit tests | State transitions, language routing, dictionary logic, metric definitions, command contracts | Real microphone or cross-app insertion behavior |
| Native Rust pipeline tests | Ordering, single delivery ownership, cancellation, storage failures, transformation fallback | All real application Accessibility behavior |
| Swift/model evaluation | Actual detector/model preparation and repeatable recognition fixtures | Universal accuracy or customer workflow reliability |
| Browser UI tests with mocked IPC | Onboarding, recovery, history, keyboard interaction, and visible feedback | Native permission attribution or packaging correctness |
| Packaged-app testing on macOS | Finder launch, permissions, actual capture, target-app insertion, focus changes, clipboard preservation, update flow | Every hardware configuration or third-party editor |

Benchmarks distinguish model loading, warm inference, cleanup, storage, delivery, and observed insertion. A fast offline-file inference number is not the latency of an entire dictation. Release-to-insertion timing starts at native stop-command entry, rather than the physical key release, and is absent when insertion is unverified.

The application source is MIT-licensed; bundled dependencies and model assets keep their own licenses and notices. Linty's contribution is the application, sequencing, native integration, recovery, and user experience around those components. It should not present upstream speech or cleanup models as proprietary Linty inventions.

Sources: [frontend build](vite.config.ts), [native dependencies](src-tauri/Cargo.toml), [Swift build integration](src-tauri/build.rs), [native pipeline tests](src-tauri/src/dictation/tests.rs), [updater client](src-tauri/src/updater.rs), [update scheduling](src/hooks/useUpdater.hook.ts), [packaged-app contribution requirements](CONTRIBUTING.md), [model notices](src-tauri/licenses/MODELS.md).

## Where to start in the repository

| Question | Start here |
|---|---|
| Who owns an entire dictation? | [dictation.rs](src-tauri/src/dictation.rs) and [backend.rs](src-tauri/src/dictation/backend.rs) |
| What does the UI send to Rust? | [dictation-options.service.ts](src/services/dictation-options.service.ts) and [useRecording.hook.ts](src/hooks/useRecording.hook.ts) |
| How is audio captured and invalidated? | [audio.rs](src-tauri/src/audio.rs), [state.rs](src-tauri/src/state.rs), and [lib.rs](src-tauri/src/lib.rs) |
| How does language select an engine? | [languages.util.ts](src/lib/languages.util.ts) and [language-preparation.service.ts](src/services/language-preparation.service.ts) |
| How are the models called? | [transcribe.rs](src-tauri/src/transcribe.rs), [parakeet.rs](src-tauri/src/parakeet.rs), [Bridge.swift](src-tauri/swift/Sources/LintyParakeet/Bridge.swift), and [reformat.rs](src-tauri/src/reformat.rs) |
| How is data saved and deleted? | [history_db.rs](src-tauri/src/history_db.rs) and [history.rs](src-tauri/src/history.rs) |
| How do we avoid a duplicate or misplaced paste? | [delivery.rs](src-tauri/src/delivery.rs), [clipboard.rs](src-tauri/src/clipboard.rs), and [paste.rs](src-tauri/src/paste.rs) |
| How are corrections learned? | [corrections/](src-tauri/src/corrections), [correction-classifier.ts](src/lib/correction-classifier.ts), and [dictionary.service.ts](src/services/dictionary.service.ts) |
| How is access restricted? | [tauri.conf.json](src-tauri/tauri.conf.json), [capabilities/](src-tauri/capabilities), and [application.toml](src-tauri/permissions/application.toml) |

All repository links on this page are pinned to the documented revision. The architecture should be reviewed when ownership, storage formats, model routing, permissions, or release behavior changes.
