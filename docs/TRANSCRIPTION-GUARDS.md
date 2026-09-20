# Transcription guards

Linty preserves ordinary words, short responses, and intentional repetition.
There is no list of forbidden transcript phrases and no minimum text length.
This applies to Whisper and both Parakeet paths (with or without
the personal dictionary). Dictionary spelling replacements remain separate.

## Decisions based on evidence

| Engine | Evidence used to reject output |
| --- | --- |
| All engines | Empty/effectively digitally silent audio: no finite sample above `1e-10` in absolute amplitude. This is a minimal signal check, not a voice activity detector. |
| Local Whisper | whisper.cpp's existing paired defaults: no-speech probability above `0.6` **and** average log probability below `-1.0`. High-confidence text overrides the silence prediction. |
| Parakeet | Silero v6 speech presence at threshold `0.3` / minimum speech `100 ms`. A bounded, detector-only gain pass rescues quiet speech. Original ASR samples stay intact. An unavailable or failed detector permits transcription. No cutoff is applied to Parakeet token confidence. |

The [September 18 VAD evaluation](VAD-EVALUATION-2026-09-18.md) supersedes the
earlier decision to leave VAD disabled for Parakeet. It does not change Whisper
filtering. Parakeet's average token confidence is not a no-speech
probability and cannot share Whisper's confidence thresholds.

The former `0.01` RMS / `2%` active-window gate could reject quiet voices and
brief speech surrounded by long pauses. The new signal check uses the tiny
silence floor found in FluidAudio's VAD and does not depend on recording length.
Noise may pass this check. Decoder confidence also cannot guarantee freedom
from hallucinations.

Repeated words generate a diagnostic message, without changing the text.
Repetition alone is insufficient evidence: emphasis and stutters are valid
dictation. The UI reports an empty result without asserting the person must
speak louder.

## Research and implementation sources

- [Investigation of Whisper ASR Hallucinations Induced by Non-Speech Audio, Section III](https://arxiv.org/html/2501.11378v1#S3) excludes everyday phrases from its removal dictionary because of false positives. It also evaluates VAD and audio alignment as supporting evidence.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/src/whisper.cpp) combines silence probability and average log probability. Linty's installed `whisper-rs 0.15.1` / `whisper-rs-sys 0.14.1` source was checked directly before retaining these defaults.
- FluidAudio `0.14.8`: `Sources/FluidAudio/VAD/VadManager.swift` defines the digital-silence floor; `ASR/Parakeet/SlidingWindow/TDT/AsrManager+TokenProcessing.swift` defines the separate Parakeet confidence calculation.

## Repeatable evaluation

Unit tests live in `src-tauri/src/transcribe_tests.rs`. They exercise all former
blocked phrases, single-byte and Unicode responses, repetition, quiet signals,
long pauses, and digital silence. Run:

```sh
cd src-tauri
cargo test --lib --features local-stt,parakeet
```

The local audio evaluation uses the app's actual transcription functions and
does not record the microphone, upload audio, download ASR models, or change
app settings. `scripts/benchmarks/generate-guard-audio.py` creates macOS speech
synthesis fixtures, attenuated variants, pauses, silence, deterministic noise,
and a tone. An optional human recording and reference text add natural-speech
variants. The JSON manifest includes fixture hashes and source categories.

```sh
python3 scripts/benchmarks/generate-guard-audio.py
# Optional: add --natural-wav /path/to/16k-mono-pcm16.wav --natural-text /path/to/reference.txt
cd src-tauri
cargo build --release --example stt_guards --features local-stt,parakeet
target/release/examples/stt_guards whisper \
  "$HOME/Library/Application Support/ai.linty.desktop/models" \
  ../artifacts/transcription-guards/manifest.json \
  ../artifacts/transcription-guards/whisper.json /path/to/ggml-silero-v5.1.2.bin
target/release/examples/stt_guards parakeet \
  "$HOME/Library/Application Support/ai.linty.desktop/models" \
  ../artifacts/transcription-guards/manifest.json \
  ../artifacts/transcription-guards/parakeet.json /path/to/ggml-silero-v5.1.2.bin
```

The optional VAD model is available from
[ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad/blob/main/ggml-silero-v5.1.2.bin).
The evaluator compares a whole-recording VAD gate at Silero's default threshold
`0.5` / minimum speech `250 ms`, and a more lenient `0.2` / `100 ms` candidate.
It uses a fresh VAD context per recording. These candidates do not modify the
app's output or crop audio; segment-based audio trimming is a different
experiment. The tool reports recognition mismatches instead of treating them
as passing accuracy tests.

## Measured result: September 17, 2026

The [recorded evaluation](benchmarks/transcription-guards-2026-09-17.json) contains
26 clips per engine: 22 speech cases and four non-speech cases. It uses Turbo Q5,
Parakeet TDT v3, and Silero v5.1.2. Human speech comes from whisper.cpp's public
[JFK sample](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav),
with quiet and silence-padded variants; the remaining voices are synthesized.

| Result without an additional VAD gate | Whisper | Parakeet |
| --- | ---: | ---: |
| Speech cases returning nonempty text | 22/22 | 22/22 |
| Speech cases matching the reference after case/punctuation normalization | 19/22 | 19/22 |
| Non-speech cases returning empty text | 2/4 | 4/4 |

The former audio gate would have rejected seven of these speech clips before
inference. Both engines now return their quiet and paused speech. The unit
tests separately guarantee that an engine result such as `I`, `no`, `thank you`,
or intentional repetition survives Linty's text handling without punctuation
being needed to bypass a filter.

**VAD was left disabled based on this September 17 comparison.** The default VAD
gate would discard three valid speech cases: very quiet `no`, very quiet
`thank you`, and very quiet JFK speech. Both engines transcribed all three
correctly. The lenient candidate still rejects two of them. These very quiet
fixtures are attenuated by 50 dB before PCM16 quantization. A confidence-only
cutoff for Parakeet is also not justified by its different score semantics.

This does not mean VAD is unhelpful: the default candidate would prevent
Whisper's `.` output for white noise and the tone. But it would also introduce
missing speech. A VAD-only rejection rule is therefore not enabled, and a
future audio-segmentation change should be tested separately on diverse real
recordings, preserving boundaries and quiet speakers.

Recognition limitations remain visible in the report: Whisper duplicates
`thank you` around long pauses and appends `you` to the silence-padded human
recording; Parakeet repeats a quiet `no` and hears `bye` as `Five`. Both spell
out the synthesized Spanish fixture. These are reported mismatches, not
hidden by deletion rules. This small corpus is a regression/evaluation aid,
not a production accuracy or accent-coverage claim.
