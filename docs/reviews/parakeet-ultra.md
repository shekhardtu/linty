# Parakeet Ultra upgrade and cleanup

The release upgrades FluidAudio from 0.14.8 to 0.17.5 and selects Parakeet Ultra
for supported languages on Apple silicon. macOS 14 and the same 25 languages
remain supported. Whisper still handles Intel Macs, broader languages and
Auto-detect. S1-mini, Candle and the Whisper weights/wrapper remain current.

## Local comparison

600 public English recordings were selected before seeing outputs: 200 each
from LibriSpeech test-clean, test-other and FLEURS en_us/test, using SHA-256
ranking with seed 20261008. Both candidates used the production Rust speech
presence guards and transcription paths on an Apple M3 Pro with 18 GiB of RAM,
macOS 26.5. Cleanup, dictionary, microphone, UI and paste were excluded.

| Sample | v3 + FluidAudio 0.14.8 WER | Ultra + FluidAudio 0.17.5 WER | Baseline / Ultra throughput |
|---|---:|---:|---:|
| LibriSpeech test-clean, 200 | 2.60% | 1.65% | 90.1× / 117.8× |
| LibriSpeech test-other, 200 | 4.12% | 3.56% | 79.6× / 112.9× |
| FLEURS en_us/test, 200 | 4.69% | 4.34% | 99.1× / 140.9× |

Both completed without inference errors or empty outputs. Across all clips,
word errors fell from 481 to 404 over 12,578 reference words (about 16% fewer
errors). These are sample results on this Mac, not full-corpus or microphone
accuracy claims. Timing varies with hardware and warm Core ML caches. A repeated
baseline FLEURS pass had identical outputs and 108.6× throughput.

The [evidence directory](../benchmarks/parakeet-ultra-2026-10-08/summary.json)
contains model/binary/manifest/result hashes, counts and normalization metadata.
Its public manifests and raw outputs can be rescored with public_corpus_score.py.
No personal recordings or history were read. Audio is not checked in; dataset
sources and CC BY 4.0 attribution are preserved in the manifests.

Ultra's installed model cache measured 633,377,927 bytes in this run. Process
RSS after warm model caching was about 130 MB for baseline and 131 MB for Ultra
on the FLEURS pass; this excludes system-managed Neural Engine memory and does
not establish total RAM parity. One earlier Ultra process peaked at 674 MB.

Upstream also reports better 24-language FLEURS and English accuracy:
[FluidAudio 0.17.3](https://github.com/FluidInference/FluidAudio/releases/tag/v0.17.3).
Those upstream results are distinct from the local English sample measurements.

## Architecture and migration

Native catalog IDs and file validation recognize both Ultra and legacy v3.
The Swift bridge resolves the version from the validated model directory and
rejects unknown directories. The newer download API uses ProgressHandler.
FluidAudio's recognized-text debug logging is disabled at all sinks.

At startup, a compatible installed model is made ready first. The preferred
model downloads through the existing coalesced transfer service; activation
waits for recording and pending dictation to finish. Failed downloads preserve
the confirmed language/model pair and usable installed engine. Existing v3
assets remain available for migration and rollback; no customer data is deleted.

The new dependency's NeMo Rust text-normalization engine is disabled through
SwiftPM traits: Linty already has its own Rust runtime and S1 cleanup. This
requires Swift 6.2+ for building (Xcode 26+); it does not raise the customer's
minimum macOS version. Deployment checks this prerequisite before building.

## Cleanup and size

The source import audit found one unused RecordingIndicator component. It and
its unused animation definitions were removed. Two unused model-management
commands, get_models_dir and delete_model_file, were removed from the handler
and main-window permission list. The unused saveWhisperPrompt hook callback was
removed while preserving the saved prompt that dictation still uses.

Release linking trims debug and local symbols with -S/-x before Tauri signing,
retaining global symbols and runtime metadata. The installed v0.0.8 universal
executable was 74,139,568 bytes; stripping a copy reduced it to 56,888,096 bytes.
The actual new signed ARM64 candidate was 32,170,080 bytes compared with the
old ARM64 slice's 39,421,872 bytes (18.4% smaller), despite the newer SDK.
The final universal bundle is measured by local deployment. Model downloads
are separate from the app bundle and installer size.

Historical benchmark reports, legal notices, build caches and legacy migration
code are retained because they remain useful; they are not unneeded shipped
model weights or duplicate app assets.
