# Native pipeline: before and after

The candidate improves preservation and delivery accounting. It does **not** establish better speech accuracy, better overall cleanup quality, or faster end-to-end dictation.

Baseline: `8dc750bc9f0bf891395c93b357447edfb811fc0b`. Candidate: this change's native pipeline. Same Mac: M3 Pro, 11 CPU cores, 18 GiB, macOS 26.5, AC power. Measurements were sequential, with builds and automated test suites stopped during inference.

## Speech recognition

Thirty identical public recordings, 212.04 seconds and 545 normalized reference words: ten clips each from LibriSpeech test-clean, test-other and FLEURS en_us/test. Three passes per clip per Linty engine, 180 new calls, no reported failures. Accuracy uses the fixed third pass. Each clip's timing is the median of passes two and three; the table reports percentiles across the thirty clip medians.

| Engine | Before WER | Candidate WER | Median before → after | p95 before → after |
|---|---:|---:|---:|---:|
| Linty Whisper Turbo Q5 | 11/545, 2.02% | 11/545, 2.02% | 1.122 → 1.074 s | 1.193 → 1.536 s |
| Linty Parakeet v3 | 18/545, 3.30% | 18/545, 3.30% | 0.0776 → 0.0732 s | 0.1112 → 0.1057 s |

Normalized transcripts match the baseline on 30/30 clips for each engine. Median timings decreased by about 4.3% and 5.7%, but Whisper p95 increased by 28.7%. This is a single sequential sample with background/thermal variation, no counterbalanced ordering and no confidence intervals. Speech runtime settings were unchanged. **Do not attribute these timing differences to the architectural changes.**

The earlier competitor measurements are retained as dated references; competitors were **not rerun**:

| Reference measured on 19 September 2026 | WER | Median / p95 warm call |
|---|---:|---:|
| Handy v0.9.7, same Whisper Q5 file | 2.02% | 0.926 / 0.990 s |
| Pindrop speech library, Parakeet v3 | 3.30% | 0.0705 / 0.1003 s |

The candidate still matches the corresponding reference's normalized transcript on every clip. These are engine-call measurements, excluding model loading, WAV I/O, microphone capture, cleanup, UI and paste. Handy used its official file CLI; Pindrop used its speech library, not the full GUI. VoiceInk remains source-only in this comparison. No whole-app ranking is supported.

## Cleanup preservation

The existing 38-case text corpus and scorer were held unchanged. Same S1-mini model, prompt, options and Metal backend. This measures text cleanup, not speech recognition.

| Fixed screening category | Before | Candidate |
|---|---:|---:|
| Exact normalized reference match | 25 | 24 |
| Needs review | 9 | 8 |
| Lexical constraint failure | 4 | 3 |
| Original retained by validator | 0 | 3 |

The unchanged scorer calls those three fallbacks `runtime-error`; inspection confirms all three completed inference and retained the original on a preservation check. They are **not** counted as successful cleanup. The original scorer's classifications remain in the evidence JSON rather than being changed to improve the result.

| Case | Before | Candidate | Assessment |
|---|---|---|---|
| 30: “one lakh fifty thousand rupees” | `₹1,050,000` | Original wording retained | Prevents incorrect numeric value; correct value is ₹150,000. |
| 14: Sara spelled S A R A | Sara replaced with a spelling sequence | Original wording retained | Preserves the explicit name; spelling cleanup remains unresolved. |
| 09: correct 2:30 to 3:15 p.m. | Valid `3:15pm` cleanup | Original wording retained | False rejection; one fewer reference match. |

The remaining 35 outputs are byte-identical to baseline. The new guard still does not repair grammar errors, fully resolve spelling instructions or delayed corrections, or preserve every emphasis/meaning distinction. Examples still needing work include the contradictory draft-send instruction (11), delayed Friday-to-Monday correction (32), and reduced emphasis (24). Reference matches and lexical constraints are screening signals, not semantic accuracy. The validator was developed using this known corpus, so the result is diagnostic and not a held-out quality estimate. Separate unit fixtures cover additional amounts, dates, names, signs, literals and ambiguous alternatives.

## Architectural improvement and limits

| Behavior | Before | Candidate evidence |
|---|---|---|
| Session ownership | React sequenced inference, transformations and delivery | One Rust worker; UI observes cached result and generation-filtered progress. |
| Recoverable original | History save followed processing/delivery | Pipeline tests assert raw save precedes cleanup and delivery; save failure suppresses paste. |
| Preservation | Primarily prompt and structural guards | Shared checks reject supported protected-detail changes and preserve raw text. |
| Delivery result | Successful Cmd+V treated as pasted | Separate verified, unverified and failed results; tests reject substring-only insertion evidence. |
| Duplicate delivery | Frontend orchestration | One worker and one delivery attempt; result reads have no delivery side effect. |
| Latency visibility | Processing excluded audio-stop time; paste ended at posting | Native timing includes finalization and optional exact insertion observation. |

Automated sequencing and UI tests establish those implementation behaviors. They do not measure real clipboard success rates or native stop-to-insertion latency. Packaged macOS acceptance is tracked separately in the release notes. The candidate's observation can add up to roughly two seconds before reporting an unverified result; there is no automatic retry.

## Evidence and reproduction

- [Speech comparison, per-clip output, timings, hashes and selection manifest](native-pipeline-speech-2026-09-19.json).
- [Candidate cleanup outputs, metrics and unchanged scorer verdicts](native-pipeline-cleanup-2026-09-19.json); [baseline cleanup](dictation-evaluation-s1-filler-fix-2026-09-19.json).
- Production harnesses: `src-tauri/examples/corpus_eval.rs` and `dictation_eval.rs`; scorers: `scripts/benchmarks/public_corpus_score.py` and `score-dictation.mjs`. The speech comparison uses the same EnglishTextNormalizer, normalization policy and versions recorded in the evidence JSON.
- Audio selection precedes decoding: first ten cases per corpus in SHA-256(`seed:id`) order, seed `20260919`. Selected IDs, references and WAV hashes are included. Source attribution: [LibriSpeech, OpenSLR 12](https://www.openslr.org/12), and [Google FLEURS](https://huggingface.co/datasets/google/fleurs), CC-BY-4.0. Reference excerpts in the evidence come from these datasets; audio is not redistributed in this PR.
- Whisper model SHA-256: `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`. Parakeet v3 assets were unchanged; Linty uses FluidAudio 0.14.8 and the prior Pindrop run used 0.15.4. Corresponding model files had matching hashes in the baseline comparison.
- Competitor pins: Handy measured v0.9.7 (`05e0aedd2906f0d82722735f930465950c476b90`); Pindrop `fe518a88bcf88259cd49bcf36e07c851289112f4`; VoiceInk source review `173cbb2b3aa0a18ab4035aa1bc9dc9fc215e88b6`.

This 3.5-minute English read-speech sample does not establish behavior on spontaneous dictation, Indian accents, code-switching, noise, long live sessions, Bluetooth, memory pressure or other hardware.

## Packaged acceptance follow-up — 2026-09-20

The Finder-launched release candidate was subsequently checked with real microphone capture and TextEdit, Chrome and Zed destinations. Testing found and fixed a native panel-hide crash. See the [native acceptance report](../releases/v0.0.54-native-acceptance.md) for delivery and clipboard evidence. The panel-threading fix does not change the speech/cleanup models or the corpus comparison above; these native trials are not a new performance benchmark.
