# Parakeet output from a recording without speech

Investigated September 17, 2026. This is a research and evaluation note; no
production speech filter, model, or dependency was changed for this investigation.

Follow-up: the [September 18 evaluation](VAD-EVALUATION-2026-09-18.md) implements
the first Parakeet VAD variant, with quiet-speech preservation as the priority.

## Local reproduction

Linty's Parakeet TDT v3 path returned `Yeah.` from synthetic 60 Hz / 120 Hz hum
with a small noise component at each tested duration: 0.5, 1, and 2 seconds.
Digital silence, hiss, and button-like clicks at those durations returned empty
text (nine other cases). Inputs were 16 kHz mono PCM16 fixtures, passed through
the existing `stt_guards` example and the app's actual transcription function.
They bypassed microphone capture and its resampler. No personal audio was used.

The same clips were evaluated with the installed Silero v5.1.2 model. Both
candidate policies (0.5 threshold / 250 ms minimum speech and 0.2 / 100 ms)
detected zero speech segments in all three hum recordings. Maximum frame
probabilities were approximately 0.0158, 0.0156, and 0.0175 respectively.
Either policy would prevent these false transcripts.

That is insufficient evidence to enable either policy: the earlier
[speech-preservation evaluation](TRANSCRIPTION-GUARDS.md) found three valid
very quiet recordings rejected by the default policy and two by the lenient
policy. Those fixtures are attenuated by 50 dB; the test is a regression aid,
not a representative microphone or accent benchmark.

Scratch inputs and reports are under `/tmp/linty-empty-press-check/`, including
`manifest.json`, `parakeet.json`, and `parakeet-vad.json`.

## Upstream evidence and its scope

- **Maintainer acknowledgment of short-audio difficulties:** in
  [FluidAudio #746](https://github.com/FluidInference/FluidAudio/issues/746#issuecomment-4888474836),
  a FluidAudio member says TDT struggles with short recordings and suggests
  EOU, Unified, or Nemotron. The report concerns real speech disappearing after
  leading silence. It does not establish the cause of words generated from hum.
- **A related report in NVIDIA's runtime:**
  [NeMo #15757](https://github.com/NVIDIA-NeMo/Speech/issues/15757) reproduces
  a short speech clip becoming empty after adding 400 ms of trailing silence.
  The reporter proposes trimming or respecting valid audio lengths. A
  maintainer requested more details; this is not a confirmed fix for Linty.
- **Confirmed preprocessing bug in another inference path:** NVIDIA merged
  [#15562](https://github.com/NVIDIA-NeMo/Speech/pull/15562), masking padded
  frames after normalization to prevent partial-chunk hallucinations. Its
  evaluations include TDT v2. Linty uses FluidAudio's CoreML path and supplies
  the actual sample count; the Python patch cannot be assumed to apply here.
- **Confirmed CoreML encoder issue:**
  [FluidAudio #872](https://github.com/FluidInference/FluidAudio/pull/872)
  reports right-context-dependent word corruption with the original v3 encoder
  and introduces an opt-in `Encoder_v2.mlmodelc` / `int8V2` variant. The default
  encoder remains unchanged. This is a useful controlled comparison, not an
  established remedy for noise-only recordings. The PR also calls for broader
  accuracy and speed evaluation before recommending it generally.
- **A matching word with a different cause:**
  [sherpa-onnx #3267](https://github.com/k2-fsa/sherpa-onnx/issues/3267)
  reports `Yeah.` with modified beam search. Linty uses FluidAudio's TDT greedy
  decoder, so changing a sherpa beam-search option is not applicable.
- **Supported speech detection:**
  [FluidAudio's VAD documentation at our pinned version](https://github.com/FluidInference/FluidAudio/blob/v0.14.8/Documentation/VAD/GettingStarted.md)
  describes a separate Silero v6 CoreML manager with frame probabilities,
  segmentation, and padding controls. Loading `AsrManager` does not invoke it.
  Our earlier v5.1.2 experiment does not evaluate that v6 implementation.
  [Silero's maintainers](https://github.com/snakers4/silero-vad/wiki/FAQ)
  recommend inspecting probabilities and tuning thresholds and minimum
  durations, and explain that recurrent state must be managed across chunks.

No reviewed source establishes an NVIDIA-confirmed cause or fix for this exact
one-second hum reproduction through FluidAudio. NVIDIA's
[noise robustness results](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3#noise-robustness)
measure recognition with speech plus noise; they do not establish reliable
rejection of recordings containing only noise.

## Linty implementation audit

| Area | Finding | Implication |
| --- | --- | --- |
| Speech detection | `audio_has_signal` in `src-tauri/src/transcribe.rs` only tests for a finite sample above `1e-10`. | Ordinary microphone noise reaches ASR. This is deliberately a digital-silence check, not VAD. |
| Minimum input | Both Rust Parakeet entry points allow 1,600 samples (100 ms); FluidAudio's `ASRConstants` requires 4,800 (300 ms). A 250 ms noise fixture produced its validation error. | Definite integration mismatch, separate from the one-second false transcript. Decide how to handle short input explicitly and test any padding before adopting it. |
| Audio format | Capture downmixes and supplies 16 kHz float samples, matching the SDK entry point. | No evidence of an input-rate declaration mismatch. |
| Resampling | `src-tauri/src/audio.rs` uses per-callback linear interpolation, rounds output length upward, and does not preserve fractional phase or apply an antialias filter. | Audio-quality gap worth correcting and testing at device rates. It cannot explain the hum reproduction, which bypassed this code. |
| Decoder lifetime | Both Swift entry points create a fresh `TdtDecoderState` per recording. | No evidence that a previous utterance or warm-up decoder state leaks into this result. |
| Padding | Linty passes the captured sample count. FluidAudio pads internally and forwards a frame-aligned valid length to preprocessing and decoding. | Inspect exported preprocessing if comparing runtimes; Linty is not simply labeling a full 15-second padded buffer as captured audio. |
| Result metadata | The basic Swift bridge returns text and timing, discarding token confidence/timestamps. | Additional metadata could support diagnosis. Token confidence alone is not a no-speech probability. |

## Recommended implementation sequence

1. Evaluate FluidAudio's Silero v6 on the hum cases and the existing short/quiet
   speech corpus, then broaden to real microphone noise and quiet speakers.
   Compare false text and lost speech together. Use fresh state per recording,
   process frames sequentially, and preserve the original audio for ASR while
   initially testing a whole-recording speech-presence decision.
2. Resolve the 100 ms / 300 ms contract mismatch. Do not assume padding is
   harmless: test it against the upstream silence-sensitive cases and genuine
   short replies. Keep the minimum-input policy distinct from speech detection.
3. Compare the current CoreML encoder with the corrected optional encoder on
   identical fixtures. A FluidAudio version bump alone does not select the new
   weights. Measure accuracy, latency, memory, and download impact before
   changing the default; alternative streaming models also need evaluation.
4. Replace the callback-local resampler with a stateful, filtered resampler and
   verify duration and callback-boundary behavior at supported microphone rates.

The proposed empty-recording behavior is to finish without inserting text when
the validated speech detector finds no speech. Words such as `yeah`, `no`, and
`thanks` must remain valid dictation. VAD thresholds, trimming, model upgrades,
and encoder replacement are separate experiments, not interchangeable fixes.
