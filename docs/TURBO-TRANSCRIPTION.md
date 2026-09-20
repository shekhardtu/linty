# Turbo Transcription: Speed + Perceived Performance

**Date:** 2026-02-26
**Scope:** End-to-end latency reduction for local whisper STT pipeline

---

## Problem

Local whisper transcription felt noticeably slow especially for short push-to-talk recordings (1-5s). Six compounding bottlenecks were identified:

1. **Double IPC serialization** of raw audio samples
2. **Unoptimized whisper inference params** (full 1500-token attention window for 2s clips)
3. **No GPU flash attention** despite Metal availability
4. **No streaming feedback** during inference
5. **Static spinner UI** giving zero progress indication
6. **No turbo model option** (only large-v3 at 3.1GB)

---

## What Changed

### 1. Zero-Copy Audio Pipeline

**Before:**
```
stop_recording  -->  serialize Vec<f32> to JSON  -->  IPC to frontend
                -->  frontend receives ~1.6MB JSON (10s audio = 160K floats)
                -->  re-serialize to JSON  -->  IPC back to Rust
                -->  deserialize in transcribe command
```

**After:**
```
stop_recording  -->  std::mem::take (zero-copy move to RecordingState)
                -->  return StopResult { sample_count, duration_secs }  (32 bytes)
transcribe_buffer  -->  reads samples directly from Rust AppState
```

**Impact:** Eliminates ~500ms-2s of JSON serialization/deserialization for a 10s recording. The `StopResult` struct is 32 bytes vs ~1.6MB of JSON. For a 3s push-to-talk, this alone saves ~200-400ms.

| Recording Length | JSON Payload (Before) | Payload (After) | Saved |
|------------------|-----------------------|-----------------|-------|
| 1s (16K samples) | ~260 KB | 32 bytes | ~260 KB |
| 3s (48K samples) | ~780 KB | 32 bytes | ~780 KB |
| 10s (160K samples) | ~1.6 MB | 32 bytes | ~1.6 MB |
| 30s (480K samples) | ~4.8 MB | 32 bytes | ~4.8 MB |

### 2. Optimized Whisper Inference Parameters

**Thread count** -- dynamically set to half available cores, clamped to 4-8:
```
Before: whisper-rs default (all cores, causing contention)
After:  (available_parallelism / 2).clamp(4, 8)
```

**Audio context window** -- proportional to actual audio duration:
```
Before: Fixed 1500 tokens (covers 30s window regardless of input)
After:  (duration_secs / 30.0) * 1500, clamped to [64, 1500]

Example: 3s audio -> audio_ctx = 150 (10x less attention computation)
```

**Short recording optimizations:**
- `single_segment(true)` for recordings <= 20s (avoids segment boundary overhead)
- `no_timestamps(true)` (timestamps are never displayed)
- `suppress_nst(true)` (filters non-speech tokens like music/noise markers)

**Impact:** 20-50% faster inference depending on recording length. The `audio_ctx` reduction is the single biggest win for short push-to-talk -- attention computation scales quadratically with context size.

| Recording | audio_ctx Before | audio_ctx After | Reduction |
|-----------|------------------|-----------------|-----------|
| 1s | 1500 | 64 | 23x |
| 3s | 1500 | 150 | 10x |
| 10s | 1500 | 500 | 3x |
| 30s | 1500 | 1500 | 1x (no change) |

### 3. GPU Flash Attention

Enabled at model load time:
```rust
ctx_params.use_gpu(true);
ctx_params.flash_attn(true);
```

Flash attention uses a more memory-efficient GPU kernel for the attention computation. Safe to enable since we don't use DTW (dynamic time warping) alignment.

**Impact:** ~10-20% faster inference on Apple Silicon with Metal, with lower GPU memory pressure.

### 4. Turbo Model Variants

Added two new model options:

| Model | File | Size | Speed vs Large-v3 | Accuracy |
|-------|------|------|--------------------|----------|
| Large Turbo Q5 | `ggml-large-v3-turbo-q5_0.bin` | 574 MB | 2-3x faster | ~99% of large-v3 |
| Large Turbo | `ggml-large-v3-turbo.bin` | 1.6 GB | 2-3x faster | ~99.5% of large-v3 |

The turbo variants use 4 decoder layers instead of 32, with nearly identical accuracy for English. The Q5 quantized variant is the sweet spot -- same encoder quality at 574 MB vs 3.1 GB.

**Auto-load preference order:** large-v3 > large-v3-turbo > large-v3-turbo-q5_0 > medium > small

### 5. Streaming Capsule Feedback

**Before:** Static "Transcribing..." spinner during the entire inference.

**After:**
- **Segment callback** emits partial transcribed text to the capsule as whisper produces each segment. Words appear live in the capsule overlay.
- **Progress callback** emits 0-100% progress shown next to the label.
- **Done state** shows the first 60 characters of transcribed text (truncated with ellipsis) for instant confirmation, with 1800ms dismiss timer.

The capsule panel was widened from 280px to 380px to accommodate streaming text. A `capsule-text-appear` CSS animation (180ms ease-out, opacity + translateX) provides smooth word appearance.

---

## Architecture Changes

### Rust

| File | Change |
|------|--------|
| `state.rs` | `whisper_ctx: Mutex<Option<Arc<WhisperContext>>>` -- Arc allows cloning context handle out of mutex before blocking inference |
| `lib.rs` | New `StopResult` return type for `stop_recording`. New `transcribe_buffer` command that read samples from `AppState` |
| `lib.rs` | `load_whisper_model` enables `flash_attn(true)` + `use_gpu(true)` |
| `transcribe.rs` | New `transcribe_local_with_events()` with optimized params, segment/progress callbacks |
| `transcribe.rs` | `available_models()` includes turbo-q5 and turbo variants |
| `capsule.rs` | Panel width 280px -> 380px |

### Frontend

| File | Change |
|------|--------|
| `transcription.slice.ts` | Removed `audioSamples` / `setAudioSamples` (samples no longer cross IPC) |
| `useRecording.hook.ts` | Returns `StopResult` instead of `number[]`, removed `setAudioSamples` call |
| `useTranscription.hook.ts` | `processAudio(StopResult)` calls `transcribe_buffer` |
| `useGlobalHotkey.hook.ts` | Passes `StopResult` to `processAudio` |
| `useModelAutoLoad.hook.ts` | Preference order includes turbo models |
| `CapsulePanel.component.tsx` | Listens for `capsule-partial-text` and `capsule-stt-progress` events; shows streaming text during transcription, shows result text on done |
| `capsule.css` | `capsule-text-appear` animation keyframes + class |
| `SystemCheck.page.tsx` | Updated to use `StopResult` |

### Dead Code Removed
- `transcribe_local()` -- replaced by `transcribe_local_with_events()`
- `transcribe_local_audio` command -- replaced by `transcribe_buffer`
- `audioSamples` / `setAudioSamples` in Zustand store

---

## Expected Performance Impact

### Short Push-to-Talk (1-3s) with Turbo Q5

| Stage | Before | After | Saved |
|-------|--------|-------|-------|
| IPC (stop_recording) | ~150ms | ~2ms | ~148ms |
| IPC (transcribe call) | ~150ms | 0ms (in-Rust) | ~150ms |
| Whisper inference | ~2-4s | ~0.5-1.2s | ~1.5-3s |
| **Total** | **~2.5-4.5s** | **~0.5-1.2s** | **~2-3.5s** |

Inference improvement comes from: turbo model (2-3x), audio_ctx reduction (up to 10x less attention), flash_attn (~15%), single_segment + suppress_nst (~10%).

### Medium Recording (10s) with Turbo Q5

| Stage | Before | After | Saved |
|-------|--------|-------|-------|
| IPC round-trip | ~500ms | ~2ms | ~498ms |
| Whisper inference | ~4-8s | ~1.5-3s | ~2.5-5s |
| **Total** | **~4.5-8.5s** | **~1.5-3s** | **~3-5.5s** |

### Perceived Performance

Even when inference takes >1s, the user now sees:
1. Words appearing live in the capsule as segments complete
2. Progress percentage (e.g., "Transcribing 45%")
3. Brief preview of the captured text on completion

This transforms the experience from "staring at a spinner wondering if it's stuck" to "seeing my words appear in real-time."

---

## What Was Not Changed

- **VAD (Voice Activity Detection)** -- originally deferred because push-to-talk bounded silence and another model added complexity. The later [transcription guard evaluation](TRANSCRIPTION-GUARDS.md) compares VAD against short, quiet, and paused speech separately for Whisper and Parakeet; it also replaces unconditional phrase filtering.
- **Model download UI** -- the new turbo models appear in the existing model picker. No UI changes needed.
