use cpal::traits::{DeviceTrait, StreamTrait};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::input_activity::{InputActivity, QUIET_STOP_SECS, QUIET_WARNING_SECS};
use crate::state::AudioCommand;

#[derive(Clone, serde::Serialize)]
struct QuietInput {
    generation: u64,
    quiet_seconds: u64,
    heard_input: bool,
}

/// The audio thread owns every CPAL stream; startup acknowledges the actual
/// device opening so a disconnected selection cannot appear to be recording.
pub fn spawn_audio_thread(
    app: AppHandle,
    buffer: Arc<Mutex<Vec<f32>>>,
    callback_count: Arc<AtomicU64>,
    generation: Arc<AtomicU64>,
) -> mpsc::Sender<AudioCommand> {
    let (tx, rx) = mpsc::channel::<AudioCommand>();
    std::thread::spawn(move || {
        let mut active_stream: Option<cpal::Stream> = None;
        let mut activity = Arc::new(Mutex::new(InputActivity::new(Instant::now())));
        let mut active_generation = 0;
        let mut previous_quiet = 0;
        loop {
            // The native worker owns the deadline and drops the stream even if
            // either webview is suspended. No inference runs during this check.
            let command = if active_stream.is_some() {
                rx.recv_timeout(Duration::from_millis(250))
            } else {
                rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
            };
            let command = match command {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if generation.load(Ordering::SeqCst) != active_generation {
                        active_stream.take();
                        continue;
                    }
                    let (quiet, heard_input) = {
                        let guard = activity.lock().unwrap_or_else(|e| e.into_inner());
                        (guard.quiet_for(Instant::now()).as_secs(), guard.heard_input)
                    };
                    let quiet = if quiet >= QUIET_WARNING_SECS {
                        quiet
                    } else {
                        0
                    };
                    let payload = QuietInput {
                        generation: active_generation,
                        quiet_seconds: quiet,
                        heard_input,
                    };
                    if quiet >= QUIET_STOP_SECS {
                        // Drop first: freeing the mic never waits for frontend IPC.
                        active_stream.take();
                        let _ = app.emit("recording-auto-stopped", &payload);
                        log::info!(
                            "[audio] Capture stopped after {}s without input activity",
                            quiet
                        );
                    } else if quiet != previous_quiet {
                        let _ = app.emit("recording-quiet", &payload);
                    }
                    previous_quiet = quiet;
                    continue;
                }
            };
            match command {
                AudioCommand::Start {
                    input_name,
                    generation: expected,
                    reply,
                } => {
                    active_stream.take();
                    if generation.load(Ordering::SeqCst) != expected || reply.is_closed() {
                        continue;
                    }
                    activity = Arc::new(Mutex::new(InputActivity::new(Instant::now())));
                    active_generation = expected;
                    previous_quiet = 0;
                    let result = start_stream(
                        app.clone(),
                        buffer.clone(),
                        callback_count.clone(),
                        input_name.as_deref(),
                        generation.clone(),
                        expected,
                        activity.clone(),
                    );
                    match result {
                        Ok(stream) => {
                            if generation.load(Ordering::SeqCst) != expected || reply.is_closed() {
                                drop(stream);
                                continue;
                            }
                            // Device setup time is not time spent listening.
                            if let Ok(mut guard) = activity.lock() {
                                *guard = InputActivity::new(Instant::now());
                            }
                            active_stream = Some(stream);
                            let _ = app.emit("recording-started", ());
                            if reply.send(Ok(())).is_err() {
                                active_stream.take();
                            }
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    }
                }
                AudioCommand::Stop => {
                    active_stream.take();
                    let _ = app.emit("recording-stopped", ());
                }
            }
        }
    });
    tx
}

fn start_stream(
    app: AppHandle,
    buffer: Arc<Mutex<Vec<f32>>>,
    callback_count: Arc<AtomicU64>,
    selected: Option<&str>,
    generation: Arc<AtomicU64>,
    expected: u64,
    activity: Arc<Mutex<InputActivity>>,
) -> Result<cpal::Stream, String> {
    let device = crate::audio_input::resolve_device(selected)?;
    {
        let mut samples = buffer.lock().map_err(|e| e.to_string())?;
        if generation.load(Ordering::SeqCst) != expected {
            return Err("Recording startup was cancelled".into());
        }
        *samples = Vec::new();
    }
    let error_app = app.clone();
    let error_generation = generation.clone();
    // Use device's default config, then downsample to 16kHz mono
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Could not read microphone configuration: {e}"))?;

    let device_sample_rate = default_config.sample_rate().0;
    let device_channels = default_config.channels();

    let config = cpal::StreamConfig {
        channels: device_channels,
        sample_rate: cpal::SampleRate(device_sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    log::info!(
        "[audio] Using device config: {}Hz, {} ch (will resample to 16kHz mono)",
        device_sample_rate,
        device_channels
    );

    let buf_clone = buffer.clone();
    let app_clone = app.clone();
    let cb_count = callback_count.clone();

    // Pre-allocate reusable scratch buffers — avoids heap allocs
    // per callback (~93/sec). Capacity grows once, reused forever.
    let mut mono_buf: Vec<f32> = Vec::with_capacity(4096);
    let mut resample_buf: Vec<f32> = Vec::with_capacity(4096);

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if generation.load(Ordering::SeqCst) != expected {
                    return;
                }
                let tick = cb_count.fetch_add(1, Ordering::Relaxed);

                // Downmix to mono, reusing scratch buffer
                mono_buf.clear();
                if device_channels > 1 {
                    mono_buf.extend(
                        data.chunks(device_channels as usize)
                            .map(|frame| frame.iter().sum::<f32>() / device_channels as f32),
                    );
                } else {
                    mono_buf.extend_from_slice(data);
                }

                // Resample to 16kHz, reusing scratch buffer
                let samples: &[f32] = if device_sample_rate != 16000 {
                    let ratio = device_sample_rate as f64 / 16000.0;
                    let output_len = (mono_buf.len() as f64 / ratio).ceil() as usize;
                    resample_buf.clear();
                    for i in 0..output_len {
                        let src_idx = i as f64 * ratio;
                        let idx = src_idx as usize;
                        let frac = (src_idx - idx as f64) as f32;
                        let s0 = mono_buf.get(idx).copied().unwrap_or(0.0);
                        let s1 = mono_buf.get(idx + 1).copied().unwrap_or(s0);
                        resample_buf.push(s0 + frac * (s1 - s0));
                    }
                    &resample_buf
                } else {
                    &mono_buf
                };

                if let Ok(mut buf) = buf_clone.lock() {
                    if generation.load(Ordering::SeqCst) != expected {
                        return;
                    }
                    buf.extend_from_slice(samples);
                }

                if let Ok(mut guard) = activity.lock() {
                    guard.observe(samples, Instant::now());
                }

                // Throttle amplitude events to ~15fps (every 6th callback
                // at ~93/sec) — UI can't display faster than this.
                if !samples.is_empty() && tick % 6 == 0 {
                    let rms: f32 =
                        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
                    let _ = app_clone.emit("audio-amplitude", rms);
                    let _ = app_clone.emit_to("capsule", "capsule-amplitude", rms);
                }
            },
            move |err| {
                if error_generation.load(Ordering::SeqCst) != expected {
                    return;
                }
                log::warn!("Audio stream error: {}", err);
                let _ = error_app.emit(
                    "audio-stream-error",
                    "Microphone disconnected. Choose an input in Linty’s menu.",
                );
            },
            None,
        )
        .map_err(|e| format!("Could not open the selected microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Could not start the microphone: {e}"))?;
    Ok(stream)
}
