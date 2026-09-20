# Dictation preparation

“Ready” means inference preparation has completed, rather than only the model
file being loaded. The preparation path is shared by startup, capture, and
transcription. Recording opens the microphone without waiting for model loading.

## Prepared components

- Parakeet: loads its CoreML assets, warms the actual cached Silero detector,
  and runs a one-second silent transcription directly through the decoder.
  Synthetic output is discarded. Runtime detector failures still allow audio
  through, but load/preparation failures prevent a false ready state.
- Whisper: runs a one-second silent inference on the selected context before
  publishing it. GPU initialization errors are reported rather than ignored.
- Parakeet vocabulary: installed CTC models run keyword-spotter inference on
  synthetic audio before becoming ready. Enabled dictionary words cause missing
  CTC assets to prepare before transcription. No user transcript is needed to warm CTC.
- S1-mini: for English or Auto-detect, any installed copy is prepared, even when correction is disabled,
  as requested. Prefill and two decode passes finish, GPU work synchronizes,
  and the synthetic KV cache is cleared. Explicit non-English languages skip S1
  preparation and cleanup. This never downloads or enables S1.

The speech engine is published only after its own preparation finishes. The
`prepare_dictation` command then checks the linked vocabulary and installed S1
before returning. Concurrent preparation shares existing engines and locks;
later calls do not repeat inference on already prepared instances.

## Lifecycle and interaction

Fresh onboarding starts the selected speech download after the language choice is confirmed.
After download, the loading command awaits preparation before the screen says
“Ready for offline dictation.” Installed S1 is included in that readiness check.

Returning launches prepare proactively. The status bar shows preparation rather
than ready until the linked components finish. Pressing the trigger opens the
microphone immediately, then starts preparation in the background. The listening
indicator, start sound, and duration follow actual microphone capture.

Releasing the trigger stops capture even when preparation is pending. Recorded
samples stay in Rust while transcription waits for readiness, with a visible
“Getting ready…” message in the pill. Concurrent requests share preparation; warm
instances do not repeat inference. Empty recordings return to idle immediately.

A background preparation failure does not interrupt capture. Transcription checks
readiness again after stop, retrying a failed preparation. A failure or a wait
exceeding three minutes uses normal dictation recovery. Cancelled attempts cannot
resume transcription or paste after a late preparation result.

Disabling correction keeps installed S1 warm. The existing idle setting still
unloads models, including S1, and marks readiness stale. Reopening the app or
starting a dictation prepares them again. Unload does not immediately trigger
reload. Active preparation and refreshed use timestamps protect freshly warmed
instances from the idle watchdog.

## Costs and limits

Auto-detect requires one to three saved spoken languages. Onboarding and
Settings → Dictation show this shortlist only when Auto-detect is selected;
an explicit language bypasses automatic language selection. Existing users with
Auto-detect and no saved shortlist must choose their languages before recording.
Each native session captures the list at start, so edits affect later recordings.
The limit is enforced in both the interface and the native capture command.

Whisper's language probabilities select the highest-scoring allowed language.
With one candidate, detection is skipped. With two or three, this replaces
Whisper's unrestricted detection pass; transcription receives an explicit code
and does not run language detection again. The wrapper recomputes the mel
features for transcription, but does not add another language-detection encoder
pass. Location, IP address, and time zone are not used to guess spoken languages.

A local replay of ten recent recordings with English/Hindi selected corrected
two Urdu-script outputs to Hindi and preserved all four English recordings.
One short Hindi recording still produced English. In separate warm runs on the
maintainer Mac, median Auto-detect time was 2.20 seconds unrestricted and
2.23 seconds with the shortlist. These single runs are not a latency guarantee
or a general accuracy benchmark. No private audio or transcript text is committed.
Short, noisy, or distorted recordings can still be recognized incorrectly.

Preparation overlaps computation with capture; it does not remove that work.
A short recording after idle can still wait for loading/compilation after stop.
Keeping installed S1 ready uses memory even with correction disabled, until idle unload.
No periodic inference loop keeps the processors busy.

Core ML uses CPU and Neural Engine for the detector; Whisper and S1 can use Metal.
This change does not alter speech thresholds, sample data, or correction prompts.
It cannot guarantee identical first/second wall-clock latency after hardware
sleep, under contention, or for different recording lengths. Preparation and
inference stay on the device.

Before this change, 40 fresh-process detector measurements on an M3 Pro found
median first inference of about 3.2 ms versus 0.43 ms for the second inference.
One silent inference on the same instance reduced the first real check to
about 0.50 ms. These measurements used cached weights and short speech clips;
they exclude first-install compilation and full transcription latency.

## Validation

`tests/ui.cleanup-warmup.mjs` holds preparation promises to verify installed and
absent S1, disabled/enabled cleanup, immediate capture, concurrent startup/capture,
first/second dictation, release before readiness, empty audio, idle reload, failure,
retry, cancellation, and preparation timeout.
`tests/ui.onboarding-models.mjs` covers first-run download/load readiness;
`tests/ui.recovery.mjs` covers capture cancellation and stale-result suppression.
These checks also cover model selection changing during preparation and a
first-run warm-up failure retrying without downloading the speech model again.

Swift tests load the actual cached detector, then check quiet speech followed by
silence. The native `stt_guards` benchmark now records load/preparation time and
can exercise installed CTC with `--vocabulary`. The installed S1 unit test checks
warm-up cancellation, retry, idempotence, and unchanged real inference output.

The [saved native measurements](benchmarks/dictation-prewarm-2026-09-18.json)
record unchanged text/errors for all 651 speech/noise fixtures, plus repeated
short-utterance checks through Parakeet, Parakeet with CTC, and Whisper. All 36
repeated-utterance checks completed without errors. The real S1 warm-up test
passed as well.

In these cached-weight runs, load/preparation took 425 ms for Parakeet, 1.62 s
for Whisper, and 15.02 s for Parakeet plus CTC at its new test location. The CTC
number includes first preparation at that location, not a per-dictation cost.
For the same short `no` clip, first/next transcription took 62/58 ms for
Parakeet, 188/206 ms with CTC, and 1155/1095 ms for Whisper. These are individual
runs demonstrating the prepared paths, not latency guarantees.

Validation also passes the release frontend/native builds, the build check
without local speech support, 73 frontend/website unit tests, 56 native tests including
the installed S1 test, and three Swift tests using the actual detector.
