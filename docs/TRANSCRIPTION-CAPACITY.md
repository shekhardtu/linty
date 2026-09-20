# Local transcription capacity — 16 September 2026

This is a direct-file capacity and quality probe on one Mac, not certification of a thirty-minute live microphone session. Both engines completed every file through thirty minutes without a crash, timeout, or benchmark memory-guard stop. Parakeet preserved the reference closely. Whisper's former settings lost large portions of the recording; timestamp-guided decoding improved completeness substantially but still produced repeated or incorrect text around pauses. The worst updated Whisper word error in this corpus was 5.27%.

The application's five-minute duration cutoff has been removed. Duration alone no longer invokes the watchdog recovery that discarded the recording. Abnormal-callback recovery remains. An active recording also prevents idle model unloading, and stopping refreshes the idle timer.

## Test conditions

- Apple M3 Pro, 18 GiB unified memory, eleven CPU cores (five performance and six efficiency), arm64, macOS 26.5 (25F71), connected to AC power.
- Release build; Whisper Large v3 Turbo Q5 using Metal and five CPU threads; Parakeet TDT v3 through FluidAudio 0.14.8 and CoreML. Models were already downloaded. No network transcription was used.
- Exact one-, five-, ten-, twenty-, and thirty-minute WAV files, 16 kHz mono, signed sixteen-bit PCM. Original English passages were synthesized locally with Samantha; every minute has a known section and a distinctive closing phrase.
- The thirty-minute reference contains 3,791 whitespace-delimited words. It contains 1445.6 seconds of generated speech segments and 354.4 seconds of explicit silence padding, distributed across the minute boundaries. It is a recording-with-pauses test, not thirty uninterrupted minutes of speech. Speech segments themselves also contain ordinary punctuation pauses.
- Each engine/duration pair used a separate process and loaded only that engine. Two inferences ran sequentially on the same input: first and repeat. Model loading and WAV decoding are excluded from inference timings and recorded separately.
- First inference is not a controlled cold-start claim: operating-system file and CoreML compilation caches were not cleared. In the initial baseline, the first Parakeet load took 15.83 seconds; later loads were much faster. Updated-suite model loads ranged from 0.18 to 0.33 seconds.
- No compiler or other benchmark was run concurrently with inference. Ordinary desktop applications remained open. The Mac already had approximately 7.5 GiB of system swap in use before the baseline; that is not memory newly consumed by Linty. System snapshots record memory pressure, load, pageouts, swapouts, and the operating system's thermal/performance warning status.

## Measured inference and quality

| Audio | Engine | First inference | Repeat inference | Audio / processing speed | Word error | Exact markers |
|---|---|---:|---:|---:|---:|---:|
| 1 min | Whisper | 3.78 s | 3.63 s | 16.5× | 1.57% | 1/1 |
| 1 min | Parakeet | 0.25 s | 0.22 s | 272.4× | 0.00% | 1/1 |
| 5 min | Whisper | 16.34 s | 16.43 s | 18.3× | 0.32% | 5/5 |
| 5 min | Parakeet | 0.95 s | 0.88 s | 340.5× | 0.00% | 5/5 |
| 10 min | Whisper | 31.51 s | 32.19 s | 18.6× | 0.87% | 10/10 |
| 10 min | Parakeet | 1.70 s | 1.72 s | 349.1× | 0.40% | 10/10 |
| 20 min | Whisper | 64.96 s | 63.82 s | 18.8× | 5.27% | 20/20 |
| 20 min | Parakeet | 3.85 s | 3.30 s | 363.5× | 0.44% | 19/20 |
| 30 min | Whisper | 97.39 s | 96.62 s | 18.6× | 2.16% | 30/30 |
| 30 min | Parakeet | 5.01 s | 4.97 s | 361.9× | 0.37% | 29/30 |

Repeat is a single second inference, not a statistically stable median or a ninety-fifth percentile. Word error is exact token-level Levenshtein distance divided by reference words after case/punctuation normalization and expansion of numbers zero through ninety-nine. It includes missing, extra, and substituted words. These percentages describe this synthetic English corpus only.

Exact marker matching is deliberately strict. Parakeet rendered the section-fifteen phrase “velvet canyon” as “Vvetel Canyon”; this explains its 19/20 and 29/30 exact-marker counts. The section itself is present, rather than a missing minute of audio. Section-level alignment and complete transcripts are retained in the local raw results.

## Measured process resources

| Audio | Engine | Avg. CPU | Sampled peak CPU | Peak RSS | Peak physical footprint | Peak Neural Engine footprint |
|---|---|---:|---:|---:|---:|---:|
| 1 min | Whisper | 5.1% | 75.7% | 685.6 MiB | 732.1 MiB | 0.0 MiB |
| 1 min | Parakeet | 273.8% | 161.9% | 134.7 MiB | 49.2 MiB | 467.7 MiB |
| 5 min | Whisper | 5.5% | 122.6% | 741.7 MiB | 785.4 MiB | 0.0 MiB |
| 5 min | Parakeet | 359.4% | 356.1% | 167.6 MiB | 82.0 MiB | 467.7 MiB |
| 10 min | Whisper | 5.7% | 206.6% | 775.0 MiB | 818.6 MiB | 0.0 MiB |
| 10 min | Parakeet | 362.4% | 394.6% | 207.2 MiB | 118.6 MiB | 467.7 MiB |
| 20 min | Whisper | 6.5% | 236.6% | 865.3 MiB | 884.5 MiB | 0.0 MiB |
| 20 min | Parakeet | 378.6% | 404.4% | 280.7 MiB | 192.2 MiB | 467.7 MiB |
| 30 min | Whisper | 5.8% | 474.3% | 968.1 MiB | 950.5 MiB | 0.0 MiB |
| 30 min | Parakeet | 365.4% | 402.1% | 352.4 MiB | 264.4 MiB | 467.7 MiB |

CPU averages use process user plus system CPU time during the repeat inference. One fully occupied CPU core is 100%; this Mac has eleven cores, so 370% is roughly 3.7 cores, not 370% of the entire machine. Peak CPU is sampled at half-second intervals across the whole process, including model loading; brief spikes can be missed. For short cases, a sampled peak can even fall below the precisely measured inference average. These are CPU measurements, not GPU or Neural Engine utilization percentages. Low Whisper CPU does not mean low accelerator or power consumption.

RSS and lifetime peak physical footprint are separate operating-system measurements. Parakeet's Neural Engine footprint is reported separately by macOS and must not be hidden behind its much smaller ordinary process figure. Do not add all columns together: they use different accounting rules and their peaks need not coincide. GUI/webview processes, unrelated CoreML services, the operating system, and other applications are not included in these process figures. This is not a minimum-RAM specification for the full application.

Across the updated suite, the before/after system snapshots showed no increase in swapouts. The memory-pressure command reported 47–54% system-wide free memory at those snapshots, and macOS reported no recorded thermal or performance warning. Some system pageouts increased while other applications remained open. These observations do not measure peak memory pressure or prove the absence of throttling.

The raw thirty-minute f32 audio buffer is 109.9 MiB. The production recorder's growing vector can reserve additional capacity. The Swift bridge currently copies that buffer into a Swift array, so audio-related memory grows with duration even when model memory remains stable.

## Changes indicated by the benchmark

| Audio | Previous Whisper word error | Timestamp-guided word error |
|---|---:|---:|
| 1 min | 6.30% | 1.57% |
| 5 min | 66.40% | 0.32% |
| 10 min | 43.06% | 0.87% |
| 20 min | 43.27% | 5.27% |
| 30 min | 42.38% | 2.16% |

1. **Removed the fixed recording cutoff and corrected idle unloading.** Two native regression tests cover long active recordings, stop-time idle reset, disabled unloading, and clock changes. No replacement duration cap was introduced.
2. **Enabled internal Whisper timestamps for recordings longer than twenty seconds.** The earlier setting forced fixed window advances and caused omissions. Timestamp tokens remain internal; displayed output stays plain text. Short-recording settings are preserved. Whisper distinguishes timestamp generation from printing timestamps in its [parameter definitions](https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h).
4. **Added repeatable, isolated measurement tools.** The runner captures per-inference timing, CPU seconds, real-time factor, word counts, error status, page-ins and context switches; per-process load/read time, RSS and physical-footprint peaks; sampled CPU/RSS/Neural Engine counters; and host memory, swap and thermal snapshots. Available raw kernel energy counters are recorded, but they are not presented as calibrated power or battery-life estimates.

## Remaining optimization priorities

- **Whisper quality around pauses is the first priority.** Its updated long recordings still contain repetitions/hallucinated phrases. Evaluate speech-aware segmentation and context handling against natural speech, quiet speakers, and pauses before promising reliable long-form output. Do not trade missing words for a better latency number.
- **Recoverable recording and incremental processing offer the largest product improvement.** Today audio stays in memory until stop and engine inference begins afterward. A locally recoverable, explicitly designed audio spool plus incremental processing could reduce waiting after stop and protect work from interruption. This was not implemented by the cutoff change; privacy and cleanup behavior need a deliberate design.
- **Avoid unnecessary long-audio copies if lower-memory Macs become a target.** The Parakeet bridge's f32-to-Swift-array copy is one candidate. The pinned FluidAudio library also exposes disk-backed processing. Measure any alternative before claiming it is faster or reduces total device memory.
- **Keep resource budgets explicit.** Long text does not need to expand the recent-history cache; it remains bounded. The existing native correction diff skips comparisons over two thousand words to avoid unbounded quadratic work; that is a correction-learning limitation, not a transcription-duration limit.
- **Run broader compatibility and live-capture checks.** Test other Apple chips, eight-/sixteen-GiB machines, battery operation, realistic speech rates and languages, background noise, microphone changes, capture timing/resampling drift, interrupted sessions, and complete paste/history behavior. Hardware acceleration utilization, temperature curves, energy per completed transcript, and a thirty-minute microphone soak are not established by these file tests.

## Compatibility conclusion

This M3 Pro completed thirty-minute inputs with both installed models. Parakeet had substantially lower processing latency and word error on this corpus. Whisper's residual repetition means completion alone is insufficient to declare it reliable for long sessions. The application's configured macOS minimum is 14.0, and its Parakeet compatibility check requires Apple Silicon; only this macOS 26.5 M3 Pro was measured. No conclusion is made about Intel Macs or other memory capacities.

## Reproduction and evidence

```sh
python3 scripts/benchmarks/generate-capacity-audio.py artifacts/capacity-new
cargo build --release --manifest-path src-tauri/Cargo.toml --example stt_capacity --features local-stt,parakeet
python3 scripts/benchmarks/run-capacity.py artifacts/capacity-new
python3 scripts/benchmarks/analyze-capacity.py artifacts/capacity-new
```

The benchmark supervisor has its own fifteen-minute per-case timeout and eight-GiB sampled-RSS guard to protect the test machine. These are test-harness safeguards, not application recording limits; no case reached either.

- [All first/repeat measurements, including previous decoding](benchmarks/capacity-m3-pro-2026-09-16.csv)
- [Machine details, input hashes, source hashes, binary hash, and measurements](benchmarks/capacity-m3-pro-2026-09-16.json)
- Local raw evidence: `artifacts/capacity-2026-09-16/` (previous decoding), `timestamp-guided/` (five-minute probe), and `verified/` (updated full suite). Each case includes full transcripts, accuracy alignment, process samples, system snapshots, and engine logs. Generated audio, executables, and raw logs remain untracked.
