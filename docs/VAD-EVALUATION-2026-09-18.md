# First Parakeet speech-presence variant

The selected policy prioritizes preserving quiet speech, as requested. It uses
FluidAudio's Silero v6 CoreML detector before both Parakeet transcription entry
points, without cropping audio or filtering words. Whisper behavior
are outside this first iteration.

## Selected policy

1. Run VAD on the original 16 kHz mono samples with a `0.3` entry threshold,
   `0.15` exit threshold, and `100 ms` minimum speech duration.
2. If no speech is found, retry the detector with peak amplitude raised toward
   `0.1`, limiting gain to `1000` (60 dB). Never attenuate an input. This pass
   has fresh recurrent state and does not modify the ASR input.
3. If either pass finds speech, send the complete original recording to ASR.
   Otherwise finish with empty text. Missing models and detector errors permit
   ASR to continue.

The detector processes frames sequentially and resets state between recordings
and between the two passes. No transcript phrases are blocked. ASR warm-up calls
the decoder directly and therefore still runs even on its synthetic silence.

Fresh Parakeet downloads include the detector before reporting completion.
The subsequent [readiness change](DICTATION-READINESS.md) warms the actual
cached detector before model loading completes. Missing detector assets are
prepared during loading; failures leave preparation retryable before capture.
Runtime detector failures still permit transcription. The cached folder is derived from
`Repo.vad.folderName`; the SDK currently uses `silero-vad`, which differs from
the folder shown in its documentation example.

## Evaluation design

The corpus contains 651 cases: 517 speech inputs and 134 non-speech inputs.
The first 177 cases were used for exploration. The final 474 cases use different
spoken recordings and noise frequencies/levels/durations. Candidate thresholds
were fixed before evaluating that set, but the final policy was selected using
its results; it is not an untouched final test. Several experimental policies
are retained in the benchmark for comparison; only the policy above is used in
the app.

- Speech includes synthesized short replies (`I`, `no`, `yeah`, `thanks`),
  German and Spanish examples, a public human JFK recording, quiet variants,
  pauses, and six speakers from the
  [Free Spoken Digit Dataset](https://github.com/Jakobovski/free-spoken-digit-dataset).
  FSDD is pinned to revision `26eb9aaf76e81b692f806f9140c2d2777410d7a1`
  and licensed CC BY-SA 4.0. Generated WAVs remain in ignored artifacts.
- The FSDD challenge uses digits zero/six from recording index 0. The separate
  validation uses all ten digits from index 1, with quiet/noisy variants and
  altered onset timing. These are related speakers, not unseen-speaker tests.
- Noise includes digital silence, hiss, clicks, tones, and harmonic hum sweeps.
  Quiet variants attenuate original samples by 30 or 50 dB before PCM16
  quantization. Some extreme cases are already misrecognized or rejected by
  Parakeet independently of VAD.

## Results and limits

The selected detector preserves all 517 speech fixtures. The ungated Parakeet
baseline produces false text on 36 non-speech fixtures; the selected detector
reduces that to 16. These remaining failures are tonal inputs that VAD accepts
as speech. This is a reduction in false text, not a guarantee against it.

The [saved measurements](benchmarks/vad-quiet-speech-2026-09-18.json) include
fixture and model hashes, candidate comparisons, and before/after native ASR
outputs and errors for every case.

| Corpus | Speech rejected by VAD | False text before | False text after |
| --- | ---: | ---: | ---: |
| Base | 0 / 25 | 2 / 16 | 0 / 16 |
| Challenge | 0 / 72 | 12 / 64 | 10 / 64 |
| Separate validation | 0 / 420 | 22 / 54 | 6 / 54 |

The native app paths preserve the exact speech output and error for all 517
speech cases. There are 56 pre-existing speech ASR errors in both runs, mainly
the SDK's minimum recording duration; these are not counted as successful
transcriptions. Non-speech ASR errors fall from 16 to 8 and are not counted as
successful silence rejection.

The original 12 empty-press reproduction cases all return empty text without
errors through the vocabulary entry point, including the three hum cases that
previously returned `Yeah.`. This run started without the detector cache and
exercised its download, completed progress, and immediate availability on load.
The large ASR assets were already present in this isolated test directory.

On an Apple M3 Pro, the warm detector alone takes a median 0.61 ms and p95
2.69 ms across these 651 cases (maximum 45.12 ms). This excludes model loading
and is not end-to-end dictation latency. The release app build, ten Rust
transcription tests, and three Swift tests with the real detector all pass.

The stricter confirmation experiment (one frame at `0.99` or consecutive frames
at `0.3`, including the gain pass) was rejected: it misses 15 speech inputs in
the separate validation set. FluidAudio's defaults and simple threshold changes
also lose speech. Lowering thresholds without handling amplitude is insufficient.
Silero v5.1.2, standard ONNX v6.0, and GGML v6.2.0 were evaluated as controls;
their thresholds are not interchangeable with the 256 ms CoreML conversion.

Existing ASR recognition errors and its 300 ms input requirement are separate
from VAD acceptance. In particular, a speech fixture passing VAD does not mean
its words were recognized correctly. No personal microphone recordings were
collected for this evaluation.

The corpus is small and mostly English, with synthetic noise and male FSDD
speakers. It does not establish performance across real microphones, accents,
music, or everyday room sounds. Further variants should preserve this speech
coverage while reducing the remaining tonal failures.

## Reproduction

From the repository root, generate the base corpus (optionally providing the
existing public JFK WAV/reference), then run the Swift benchmark:

```sh
python3 scripts/benchmarks/generate-guard-audio.py artifacts/vad-v6/corpus \
  --natural-wav artifacts/transcription-guards/jfk-source.wav \
  --natural-text artifacts/transcription-guards/jfk-reference.txt
python3 scripts/benchmarks/generate-vad-challenge.py
python3 scripts/benchmarks/generate-vad-challenge.py artifacts/vad-v6/holdout --holdout
swift build -c release --package-path scripts/benchmarks/vad-v6
scripts/benchmarks/vad-v6/.build/release/LintyVadBench \
  artifacts/vad-v6/holdout/manifest.json artifacts/vad-v6/model-cache \
  artifacts/vad-v6/holdout-production.json
```

The Swift benchmark imports the app's `SpeechPresenceDetector`, checks that its
decisions match the selected experimental policy, and records its runtime.
Frame probabilities, fixture hashes, rejected speech, and passed noise are
retained in the generated JSON. Model downloads use only the supplied cache.

The native `stt_guards` example exercises the integrated app path. `--prepare`
also exercises the production model downloader; `--vocabulary` exercises the
dictionary entry point (non-speech inputs need no CTC model). Existing Parakeet
installations without the detector download it while loading; use an isolated
benchmark models directory for these comparisons.

```sh
cd src-tauri
cargo build --release --example stt_guards --features local-stt,parakeet
target/release/examples/stt_guards parakeet /path/to/benchmark-models \
  ../artifacts/vad-v6/corpus/manifest.json /tmp/integrated-report.json --prepare
target/release/examples/stt_guards parakeet /path/to/benchmark-models \
  ../artifacts/vad-v6/corpus/manifest.json /tmp/ungated-report.json --ungated
```

Swift tests cover an unavailable detector, a cache probe without network side
effects, and speech followed by silence using the actual installed model:

```sh
LINTY_VAD_TEST_MODEL_DIR=/path/to/parakeet-tdt-0.6b-v3 \
LINTY_VAD_TEST_SPEECH_WAV=/path/to/no-very-quiet.wav \
  swift test -c release --package-path src-tauri/swift
```

The optional ONNX comparison uses `scripts/benchmarks/vad-reference.py` with
NumPy and ONNX Runtime in an isolated environment. It follows the model owner's
[32 ms input/state contract](https://github.com/snakers4/silero-vad/blob/v6.0/src/silero_vad/utils_vad.py).
The newer GGML control model comes from
[ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad/tree/c5c26827b67dfd053856f92e824e14fdcc123daf).
