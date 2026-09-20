use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

use crate::state::{AppState, AudioCommand};

const TICK_INTERVAL_SECS: u64 = 2;
/// Callbacks/sec threshold — CoreAudio typically fires ~93/sec at 16kHz.
/// 1000/sec sustained for 2 consecutive ticks indicates a runaway callback.
const MAX_CALLBACKS_PER_SEC: u64 = 1000;
/// Re-check fn-key monitor liveness every N ticks (15 × 2s = 30s).
#[cfg(target_os = "macos")]
const MONITOR_CHECK_EVERY_TICKS: u64 = 15;

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Resolve state once — AppState lives for the lifetime of the app.
        // Busy-wait only until Tauri has finished .manage(); in practice immediate.
        let state = loop {
            if let Some(s) = app.try_state::<AppState>() {
                break s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };

        let mut consecutive_high_ticks: u32 = 0;
        let mut silent_ticks: u32 = 0;
        #[cfg(target_os = "macos")]
        let mut tick_count: u64 = 0;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(TICK_INTERVAL_SECS)).await;

            // ── Check 0: fn-key monitor liveness ──
            // If monitor creation failed (e.g., a wake reinit fired before the
            // window server was ready), the fn key stays dead until the next
            // wake. Retry from the main thread — NSEvent APIs are main-thread-only.
            // No-ops instantly while the monitor is active.
            #[cfg(target_os = "macos")]
            {
                tick_count += 1;
                if tick_count % MONITOR_CHECK_EVERY_TICKS == 0 {
                    let app_clone = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        crate::fnkey::reinit_monitor_if_needed(app_clone);
                    });
                }
            }

            // ── Check 1: Callback rate ──
            let count = state.audio_callback_count.swap(0, Ordering::Relaxed);
            let rate = count / TICK_INTERVAL_SECS;
            let recording = state
                .recording
                .lock()
                .map(|r| r.is_recording)
                .unwrap_or(false);
            // Digital silence still produces callbacks. No callbacks at all
            // means capture has stalled or its device disappeared.
            silent_ticks = if recording && count == 0 {
                silent_ticks + 1
            } else {
                0
            };
            if silent_ticks >= 4 {
                recover(
                    &app,
                    &state,
                    "Microphone stopped responding. Check your input and try again.",
                )
                .await;
                silent_ticks = 0;
                continue;
            }

            if rate > MAX_CALLBACKS_PER_SEC {
                consecutive_high_ticks += 1;
                log::warn!(
                    "[watchdog] High callback rate: {}/sec (tick {}/2)",
                    rate,
                    consecutive_high_ticks
                );
            } else {
                consecutive_high_ticks = 0;
            }

            if consecutive_high_ticks >= 2 {
                log::error!("[watchdog] Runaway audio callbacks detected — recovering");
                recover(&app, &state, "Abnormal audio activity detected").await;
                consecutive_high_ticks = 0;
                continue;
            }

            // Recording duration is not an error: keep captured audio until the
            // user stops. Recovery is reserved for abnormal audio callbacks.

            // ── Check 2: idle model unload (local STT) ──
            if !recording {
                if let Some(reformatter) = app.try_state::<crate::reformat::ReformatState>() {
                    #[cfg(feature = "local-stt")]
                    let idle_ms = state.model_idle_unload_secs.load(Ordering::Relaxed) * 1000;
                    #[cfg(not(feature = "local-stt"))]
                    let idle_ms = 15 * 60 * 1000;
                    if reformatter.unload_if_idle(crate::now_epoch_ms(), idle_ms) {
                        let _ = app.emit("model-idle-unloaded", ());
                    }
                }
            }
            // A local model keeps ~0.5 GB resident. Drop it after the
            // user-configured idle time (Settings; 0 = never); transcribe_buffer
            // reloads it transparently on the next dictation. An in-flight
            // inference is safe — it holds its own Arc clone.
            #[cfg(feature = "local-stt")]
            {
                let unload_secs = state.model_idle_unload_secs.load(Ordering::Relaxed);
                let last_used = state.local_model_last_used_at.load(Ordering::Relaxed);
                if unload_secs > 0 && last_used > 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let idle_secs = now.saturating_sub(last_used) / 1000;
                    let recording = state
                        .recording
                        .lock()
                        .map(|recording| recording.is_recording)
                        .unwrap_or(true);
                    if should_unload_model(recording, unload_secs, last_used, now) {
                        // Preparation owns this lock until every linked model
                        // is warm. Never evict an instance while publishing it.
                        let Ok(_load_guard) = state.local_model_load_lock.try_lock() else {
                            continue;
                        };
                        let last_used = state.local_model_last_used_at.load(Ordering::Relaxed);
                        if !should_unload_model(recording, unload_secs, last_used, now) {
                            continue;
                        }
                        let unloaded = state.unload_local_models();
                        state.local_model_last_used_at.store(0, Ordering::Relaxed);
                        if unloaded {
                            log::info!(
                                "[watchdog] Local model idle for {}min — unloaded to free memory",
                                idle_secs / 60
                            );
                            let _ = app.emit("model-idle-unloaded", ());
                        }
                    }
                }
            }
        }
    });
}

async fn recover(app: &tauri::AppHandle, state: &AppState, reason: &str) {
    state.audio_generation.fetch_add(1, Ordering::SeqCst);
    // 1. Send Stop command to audio thread
    if let Ok(tx_guard) = state.audio_tx.lock() {
        if let Some(tx) = tx_guard.as_ref() {
            let _ = tx.send(AudioCommand::Stop);
        }
    }

    // 2. Clear state
    state.audio_callback_count.store(0, Ordering::Relaxed);

    // Drop buffer contents and release memory (not just clear — avoids retaining
    // a potentially huge allocation from a runaway recording).
    if let Ok(mut buf) = state.audio_buffer.lock() {
        *buf = Vec::new();
    }

    if let Ok(mut rec) = state.recording.lock() {
        rec.is_recording = false;
        rec.samples = Default::default();
        rec.history_audio = None;
        rec.audio_consent = None;
    }

    // 3. Drop stale audio_tx so a fresh thread is spawned next recording
    if let Ok(mut tx_guard) = state.audio_tx.lock() {
        *tx_guard = None;
    }

    // 4. Emit recovery event to frontend
    let _ = app.emit("watchdog-recovery", reason);

    // The frontend displays the reason in the capsule and owns its dismissal.
    // A delayed native hide could otherwise dismiss a new recording.

    log::info!("[watchdog] Recovery complete: {}", reason);
}

#[cfg(feature = "local-stt")]
fn should_unload_model(recording: bool, unload_secs: u64, last_used: u64, now: u64) -> bool {
    !recording
        && unload_secs > 0
        && last_used > 0
        && now.saturating_sub(last_used) / 1000 > unload_secs
}

#[cfg(all(test, feature = "local-stt"))]
mod tests {
    use super::should_unload_model;

    #[test]
    fn a_long_recording_keeps_its_model_ready() {
        let started = 1_000;
        let thirty_minutes_later = started + 30 * 60 * 1000;
        assert!(!should_unload_model(
            true,
            60,
            started,
            thirty_minutes_later
        ));
        assert!(should_unload_model(
            false,
            60,
            started,
            thirty_minutes_later
        ));
        // Stopping refreshes last use: the idle clock starts again afterward.
        assert!(!should_unload_model(
            false,
            60,
            thirty_minutes_later,
            thirty_minutes_later
        ));
        assert!(should_unload_model(
            false,
            60,
            thirty_minutes_later,
            thirty_minutes_later + 61_000
        ));
    }

    #[test]
    fn disabled_unload_unused_models_and_clock_changes_do_not_unload() {
        assert!(!should_unload_model(false, 0, 1_000, 9_000_000));
        assert!(!should_unload_model(false, 60, 0, 9_000_000));
        assert!(!should_unload_model(false, 60, 9_000_000, 1_000));
    }
}
