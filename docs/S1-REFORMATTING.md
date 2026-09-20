# Local transcript reformatting

Settings → Dictation → Text cleanup → Clean up on this Mac enables an optional English text
normalizer after on-device speech recognition. It is off by default.
The Settings download installs S1-mini by Superwhisper (Q4_K_M, about 496 MB
including the tokenizer). Writing style, layout, and list controls are under
Customize cleanup. Keep as spoken disables extra rewriting. Inference runs locally through Candle on Metal, with
CPU fallback when no Metal device is available. Audio and text stay on the device.

S1-mini can remove fillers,
correct punctuation and grammar, normalize numbers, and produce plain-text
lists and email layout. This integration pastes text; it does not insert native
rich-text bold styling. “Automatic” selects email layout for Apple Mail,
Outlook, and Spark when app tracking supplies a recognized bundle ID. Browsers
and unrecognized apps use general text. Users can override that choice. This
selects layout only: editor contents, project vocabulary, and conversation
context are not passed to the model. S1-mini does not support general app-aware
instructions or a code-editor context mode.

Explicit non-English languages pass through unchanged. Auto-detection requires
confident English identification; short text may be skipped. Selecting English
allows short English dictations to be processed without that ambiguity.

## Storage and measurements

Each history record retains these separate values:

- `rawText`: the speech engine output, before S1-mini.
- `reformattedText`: a successfully completed S1-mini output, before dictionary
  replacements. Absent when disabled, skipped, or rejected.
- `pastedText`: the text submitted through the successful paste command; this
  does not confirm that the destination app accepted it.
- `finalText`: the final text, which may subsequently be edited in History.

Existing correction records associate later edits with the same transcript ID.
History edits preserve the original snapshots and measurements. Retention,
deletion, undo, and JSON export apply to them together. Optional audio retention
is governed separately by the [audio privacy policy](AUDIO-PRIVACY.md); it is off
by default. There is no separate analytics upload.

`reformatting` records the selected options, outcome, skip/failure reason,
language detection/confidence, model and tokenizer revisions, quantization,
prompt/runtime versions, device backend, hardware/OS information, input/output
lengths, token counts, completed chunks, and whether text changed. Timings include
model loading, prefill, decoding, first token, total native execution, and total
frontend round trip (including waiting for background model loading). Missing
measurements remain absent rather than being reported as measured zeroes.

The parent record also retains speech model/language, audio duration and sample
count, speech recognition time, paste outcome/time,
dictionary replacements, application identity when enabled, and total processing
time. These support later latency and edit-rate comparisons; they do not directly
measure customer satisfaction or prove causality.

## Runtime and failure handling

The exact published S1-mini control prompt is used with thinking disabled and
greedy decoding. Model and tokenizer revisions are pinned in
`src-tauri/src/reformat.rs`; downloads verify SHA-256 and byte counts before
marking the installation complete. The bundled license and notice accompany the
installed files. Files are verified again on a cold load.

Enabling reformatting shows “Preparing on-device cleanup…” while the model loads
and runs a synthetic prompt through prefill and two cached decode passes. The GPU
finishes that work and the temporary KV cache is cleared before cleanup becomes
enabled. Preparation failures leave the previous cleanup mode selected and allow
retry. The synthetic input/output is never saved to history or pasted.

Installed cleanup prepares at startup even when autocorrection is disabled.
The shared dictation preparation command checks it again before opening the
microphone, so startup and idle reloads finish warm-up before capture begins.
Repeated preparation reuses a warmed engine and never downloads assets or
enables correction. Disabling correction keeps the installed model prepared;
the configured idle timeout still releases it. Releasing a hold-to-talk key
during preparation cancels that recording attempt without cancelling shared
model preparation. See [dictation readiness](DICTATION-READINESS.md).
There is a bounded
generation deadline, cancellation between forward passes, and no transcript KV
cache retained between requests. Long inputs are split at whitespace into
bounded chunks. Every chunk must finish; a failure, timeout, truncation, or
rejected output preserves the complete original. Empty output is accepted only
when its input chunk contains recognizable `um`/`uh` fillers and ordinary speech
punctuation; meaningful text, quoted words, initials, and unknown content retain
the empty-output safeguard. Accepted empty chunks add no blank paragraphs. If
the whole dictation cleans to nothing, recording finishes quietly without
clipboard changes, a paste, or an empty History entry; pending audio is discarded.
Output checks also catch control-token and extreme length results, but do not
guarantee semantic fidelity. The model's required prompt is unchanged.

Reformatting failures keep the original transcript. The personal dictionary
still runs after reformatting or fallback. Completed transcripts are saved even
when clipboard preparation or pasting fails.

## Validation and latency

Run `yarn test`, `yarn build`, and
`cargo test --lib --features local-stt,parakeet` from `src-tauri` for native tests.
The native tests cover control prompts, Unicode chunk boundaries, language
skips, cancellation, failures, and preservation of snapshots/metrics through
history edits, deletion/undo, reopening, and export.

`yarn test:cleanup` checks preparation before enabling, the pending/error UI,
retry, startup preparation, and recording without waiting for preparation. To
also exercise warm-up cancellation/retry and verify that its cache does not alter
real inference output, run the installed-model test:

```sh
cd src-tauri
LINTY_S1_TEST_MODEL_DIR="$HOME/Library/Application Support/ai.linty.desktop/models/s1-mini" \
  cargo test --release --lib --features local-stt,parakeet reformat::tests -- --include-ignored
```

The production inference path can be exercised without microphone or clipboard
access using:

```sh
cd src-tauri
cargo run --release --example s1_bench --features local-stt,parakeet -- \
  "$HOME/Library/Application Support/ai.linty.desktop/models/s1-mini" --prepare
```

`--prepare` reports the loading/warm-up duration separately and checks repeated
preparation before timing two real corrections. Omit it to time a cold first
correction followed by a repeat.

A follow-up run with the same 19-word input took 2,081 ms to load and warm up,
then 237 ms for the first correction and 219 ms for the second. Repeated
preparation took less than 0.001 ms. The unprepared baseline took 2,169 ms for its
first correction, including 1,916 ms loading. All four outputs matched. These
were single release-build runs; OS/Metal caches were not cleared, so this does
not measure first-ever shader compilation. Raw results are in
`docs/benchmarks/s1-mini-warmup-2026-09-17.json`.

An initial two-call smoke benchmark on this Mac processed a 19-word synthetic
transcript in 8,690 ms cold (including 2,095 ms model loading and 5,728 ms initial
prefill/Metal initialization), then 252 ms warm. Both outputs correctly followed
the spoken Friday-to-Monday correction and formatted three items as a list.
These are individual release-build measurements, not percentile estimates.
Debug builds, longer text, other devices, concurrent speech model activity, and
waiting for background loading can take longer. The raw benchmark artifact is
`docs/benchmarks/s1-mini-2026-09-17.json`.

If a development Settings screen reports that S1-mini commands are missing,
rebuild and restart the Rust app. Vite hot reload updates only the frontend;
an already-running native binary cannot acquire new commands.
