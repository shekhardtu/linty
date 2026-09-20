mod application;
mod audio;
mod audio_input;
#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod capsule;
#[cfg(target_os = "macos")]
mod clipboard;
#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod corrections;
mod delivery;
mod dictation;
#[cfg(target_os = "macos")]
mod fnkey;
mod history;
mod history_db;
mod input_activity;
mod legacy_settings;
pub mod logging;
mod model_store;
pub use model_store::sha256_hex;
#[cfg(feature = "parakeet")]
pub mod parakeet;
mod paste;
mod pcm_wav;
#[cfg(target_os = "macos")]
mod permissions;
pub mod reformat;
mod state;
pub mod text_validation;
pub mod transcribe;
mod tray;
mod updater;
pub mod vocabulary;
mod watchdog;

use state::{AppState, AudioCommand};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, WindowEvent,
};

/// Lightweight result from stop_recording — samples stay in Rust.
#[derive(Clone, serde::Serialize)]
pub struct StopResult {
    sample_count: usize,
    duration_secs: f64,
    recording_generation: u64,
    application: Option<application::ApplicationIdentity>,
}

/// System-level fn key binding status (issue #32 — macOS Dictation double-paste).
#[derive(serde::Serialize)]
struct FnKeyConflict {
    /// AppleFnUsageType: 0 = Do Nothing, 1 = Change Input Source,
    /// 2 = Show Emoji & Symbols, 3 = Start Dictation. None = unset (macOS default).
    usage_type: Option<i64>,
    conflict: bool,
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Load a whisper model from the app models dir on a blocking thread.
/// Never call this on the main thread path — the read + Metal init takes seconds.
#[cfg(feature = "local-stt")]
async fn load_whisper_ctx(
    app: &tauri::AppHandle,
    filename: &str,
) -> Result<whisper_rs::WhisperContext, String> {
    use whisper_rs::{WhisperContext, WhisperContextParameters};

    let model_path = model_store::speech_path(&models_dir(app)?, filename)?;

    if !model_path.exists() {
        log::error!("[stt] Model file not found: {}", model_path.display());
        return Err(format!("Model not found: {}", model_path.display()));
    }

    log::info!("[stt] Loading model from: {}", model_path.display());
    let path_str = model_path.to_str().ok_or("Invalid path")?.to_string();

    tokio::task::spawn_blocking(move || {
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.use_gpu(true);
        let ctx = WhisperContext::new_with_params(&path_str, ctx_params)
            .map_err(|e| format!("Failed to load model: {}", e))?;
        warm_up_whisper(&ctx)?;
        Ok(ctx)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
    Ok(data_dir.join("models"))
}

/// A resident local speech engine, cloned out of AppState before blocking inference.
#[cfg(feature = "local-stt")]
enum LocalEngine {
    Whisper(Arc<whisper_rs::WhisperContext>),
    #[cfg(feature = "parakeet")]
    Parakeet(Arc<parakeet::ParakeetEngine>),
}

#[cfg(feature = "local-stt")]
fn resident_local_engine(state: &AppState) -> Result<Option<LocalEngine>, String> {
    #[cfg(feature = "parakeet")]
    {
        let guard = state.parakeet_engine.lock().map_err(|e| e.to_string())?;
        if let Some(engine) = guard.as_ref() {
            return Ok(Some(LocalEngine::Parakeet(Arc::clone(engine))));
        }
    }
    let guard = state.whisper_ctx.lock().map_err(|e| e.to_string())?;
    Ok(guard
        .as_ref()
        .map(|ctx| LocalEngine::Whisper(Arc::clone(ctx))))
}

/// Load `filename` (whisper .bin or the Parakeet bundle) into memory, evicting
/// whichever engine was resident so only one model is ever loaded.
/// Caller must hold `local_model_load_lock`.
#[cfg(feature = "local-stt")]
async fn load_local_engine(
    app: &tauri::AppHandle,
    state: &AppState,
    filename: &str,
) -> Result<LocalEngine, String> {
    if transcribe::is_parakeet_model(filename) {
        #[cfg(feature = "parakeet")]
        {
            let dir = model_store::speech_path(&models_dir(app)?, filename)?;
            let ctc_dir = model_store::vocabulary_path(&models_dir(app)?)?;
            log::info!("[stt] Loading Parakeet bundle from: {}", dir.display());
            let started = std::time::Instant::now();
            let engine = tokio::task::spawn_blocking(move || {
                let engine = parakeet::ParakeetEngine::load(&dir)?;
                // Installed vocabulary models belong to this instance too.
                // Publish it only after their inference warm-up has completed.
                if ctc_dir.is_dir() {
                    engine.load_ctc(&ctc_dir)?;
                }
                Ok::<_, String>(engine)
            })
            .await
            .map_err(|e| format!("Task join error: {}", e))??;
            log::info!(
                "[stt] Parakeet loaded in {:.0}ms",
                started.elapsed().as_millis()
            );
            let engine = Arc::new(engine);
            // Evict whisper outside its lock: freeing a model can take a moment
            // and other threads probe these slots while inference runs.
            let previous = state.whisper_ctx.lock().map_err(|e| e.to_string())?.take();
            *state.parakeet_engine.lock().map_err(|e| e.to_string())? = Some(Arc::clone(&engine));
            drop(previous);
            return Ok(LocalEngine::Parakeet(engine));
        }
        #[cfg(not(feature = "parakeet"))]
        return Err("This build does not include Parakeet support".to_string());
    }

    let ctx = Arc::new(load_whisper_ctx(app, filename).await?);
    // Same eviction rule as above: take the old engine out, release the lock,
    // then let it drop (ParakeetEngine::drop blocks on the Swift actor's cleanup).
    #[cfg(feature = "parakeet")]
    let previous = state
        .parakeet_engine
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    *state.whisper_ctx.lock().map_err(|e| e.to_string())? = Some(Arc::clone(&ctx));
    #[cfg(feature = "parakeet")]
    drop(previous);
    Ok(LocalEngine::Whisper(ctx))
}

/// Resolve the engine for the selected local model, transparently reloading it
/// after the watchdog's idle unload. Runs BEFORE the recorded samples are taken
/// so a failed load leaves them intact for a retry.
#[cfg(feature = "local-stt")]
async fn resolve_local_engine(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<LocalEngine, String> {
    if let Some(engine) = resident_local_engine(state)? {
        return Ok(engine);
    }
    // Serialize with other loads, then re-check — a concurrent load may have
    // finished while we waited for the lock.
    let _load_guard = state.local_model_load_lock.lock().await;
    if let Some(engine) = resident_local_engine(state)? {
        return Ok(engine);
    }
    let filename = state
        .local_model_filename
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let Some(filename) = filename else {
        return Err("Local model not loaded".to_string());
    };
    log::info!(
        "[cmd] transcribe_buffer: reloading idle-unloaded model {}",
        filename
    );
    load_local_engine(app, state, &filename).await
}

/// Run actual inference before publishing the freshly loaded context. Called
/// on the model-loading worker, never on the main/audio thread.
#[cfg(feature = "local-stt")]
pub fn warm_up_whisper(ctx: &whisper_rs::WhisperContext) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Whisper preparation failed: {e}"))?;
    let mut params =
        whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(1);
    params.set_single_segment(true);
    params.set_no_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    state
        .full(params, &vec![0.0; 16000])
        .map_err(|e| format!("Whisper preparation failed: {e}"))?;
    log::info!(
        "[stt] Whisper inference prepared in {}ms",
        started.elapsed().as_millis()
    );
    Ok(())
}

async fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    track_application: Option<bool>,
) -> Result<u64, String> {
    let previous_generation = state.audio_generation.load(Ordering::SeqCst);
    // Capture never waits for database locks, disk I/O or retention cleanup.
    // The cache is populated in the background; unavailable consent fails closed.
    let audio_consent = app.state::<history::HistoryState>().capture_consent();
    let application = if track_application.unwrap_or(false) {
        let (reply, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(application::frontmost_application());
        })
        .map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(3), receive)
            .await
            .map_err(|_| "Could not identify the active application. Try again.".to_string())?
            .map_err(|e| e.to_string())?
    } else {
        None
    };
    let (input_name, generation) = {
        let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
        if state.audio_generation.load(Ordering::SeqCst) != previous_generation {
            return Err("Recording startup was cancelled".into());
        }
        if rec.is_recording {
            return Err("Already recording".into());
        }
        let selected = audio_input::snapshot(&app).selected;
        rec.samples = Default::default();
        rec.history_audio = None;
        rec.audio_consent = audio_consent;
        rec.application = application;
        rec.is_recording = true;
        (
            selected,
            state.audio_generation.fetch_add(1, Ordering::SeqCst) + 1,
        )
    };

    // Reset callback monitoring and keep the local model warm while recording.
    {
        state.audio_callback_count.store(0, Ordering::Relaxed);
        #[cfg(feature = "local-stt")]
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);
    }

    {
        let mut tx_guard = state.audio_tx.lock().map_err(|e| e.to_string())?;
        if tx_guard.is_none() {
            let tx = audio::spawn_audio_thread(
                app.clone(),
                Arc::clone(&state.audio_buffer),
                Arc::clone(&state.audio_callback_count),
                Arc::clone(&state.audio_generation),
            );
            *tx_guard = Some(tx);
        }
    }

    let (reply, ready) = tokio::sync::oneshot::channel();
    let sent = state
        .audio_tx
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .ok_or_else(|| "Audio thread is unavailable".to_string())?
        .send(AudioCommand::Start {
            input_name,
            generation,
            reply,
        });
    let result = match sent {
        Ok(()) => tokio::time::timeout(std::time::Duration::from_secs(8), ready)
            .await
            .map_err(|_| "Microphone did not start. Check your input and try again.".to_string())
            .and_then(|reply| reply.map_err(|_| "Audio startup was interrupted".to_string()))
            .and_then(|result| result),
        Err(error) => Err(error.to_string()),
    };
    if result.is_err() {
        log::warn!("[audio] Microphone startup failed");
        if let Ok(mut rec) = state.recording.lock() {
            if state.audio_generation.load(Ordering::SeqCst) == generation {
                rec.is_recording = false;
            }
        }
    }
    result.map(|()| generation)
}

/// Abandon the old capture worker. Generation checks prevent a late startup or
/// old CoreAudio callback from modifying the next recording's buffer.
#[tauri::command]
async fn recover_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    app.state::<dictation::Coordinator>().cancel();
    app.state::<reformat::ReformatState>().cancel();
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    state.audio_generation.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = state.audio_tx.lock().map_err(|e| e.to_string())?.take() {
        let _ = tx.send(AudioCommand::Stop);
    }
    rec.is_recording = false;
    rec.samples = Default::default();
    rec.history_audio = None;
    rec.audio_consent = None;
    rec.application = None;
    *state.audio_buffer.lock().map_err(|e| e.to_string())? = Vec::new();
    state.audio_callback_count.store(0, Ordering::Relaxed);
    log::info!("[recovery] Recording reset; next attempt will open a fresh audio stream");
    Ok(())
}

async fn stop_recording(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<StopResult, String> {
    let generation = state.audio_generation.load(Ordering::SeqCst);
    // A long recording is activity, not idle time. Start the idle clock at stop.
    #[cfg(feature = "local-stt")]
    state
        .local_model_last_used_at
        .store(now_epoch_ms(), Ordering::Relaxed);

    {
        let tx_guard = state.audio_tx.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = tx_guard.as_ref() {
            tx.send(AudioCommand::Stop).map_err(|e| e.to_string())?;
        }
    }

    // Let the audio thread drain in-flight callbacks — async so the main
    // thread keeps servicing events (sync commands run on the main thread).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    if state.audio_generation.load(Ordering::SeqCst) != generation {
        return Err("Recording was cancelled".into());
    }

    // Zero-copy move: take samples out of audio buffer, place into recording state
    let samples = {
        let mut buf = state.audio_buffer.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *buf)
    };

    let sample_count = samples.len();
    let duration_secs = sample_count as f64 / 16000.0;
    log::info!(
        "[cmd] stop_recording: {} samples ({:.1}s audio)",
        sample_count,
        duration_secs
    );

    rec.is_recording = false;
    let samples = Arc::new(samples);
    rec.history_audio =
        rec.audio_consent
            .take()
            .filter(|_| sample_count > 0)
            .map(|consent_epoch| history_db::PendingAudio {
                generation,
                consent_epoch,
                samples: Arc::clone(&samples),
            });
    rec.samples = samples;
    let application = rec.application.take();

    Ok(StopResult {
        sample_count,
        duration_secs,
        recording_generation: generation,
        application,
    })
}

/// Transcribe audio samples held in Rust state via local whisper model.
/// Samples never cross IPC — read directly from RecordingState.
async fn transcribe_buffer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    prompt: Option<String>,
    language: Option<String>,
    vocabulary: Option<Vec<vocabulary::VocabTerm>>,
    filename: Option<String>,
) -> Result<transcribe::Transcription, String> {
    // Dictionary terms are used by Parakeet only; whisper gets them via `prompt`.
    let _ = &vocabulary;
    #[cfg(feature = "local-stt")]
    {
        let generation = state.audio_generation.load(Ordering::SeqCst);
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);

        // Resolve the engine BEFORE taking samples — if the model can't be
        // loaded, we fail early and leave samples intact for a retry.
        let engine = if let Some(filename) = filename {
            let _guard = state.local_model_load_lock.lock().await;
            let selected = state
                .local_model_filename
                .lock()
                .map_err(|e| e.to_string())?
                .clone();
            if selected.as_ref() == Some(&filename) {
                match resident_local_engine(&state)? {
                    Some(engine) => engine,
                    None => load_local_engine(&app, &state, &filename).await?,
                }
            } else {
                let engine = load_local_engine(&app, &state, &filename).await?;
                *state
                    .local_model_filename
                    .lock()
                    .map_err(|e| e.to_string())? = Some(filename);
                engine
            }
        } else {
            resolve_local_engine(&app, &state).await?
        };
        if state.audio_generation.load(Ordering::SeqCst) != generation {
            return Err("Transcription was cancelled".into());
        }

        // Take samples from recording state (zero-copy move)
        let samples = {
            let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
            if state.audio_generation.load(Ordering::SeqCst) != generation {
                return Err("Transcription was cancelled".into());
            }
            std::mem::take(&mut rec.samples)
        };

        log::debug!(
            "[cmd] transcribe_buffer: {} samples ({:.1}s)",
            samples.len(),
            samples.len() as f64 / 16000.0
        );

        match engine {
            LocalEngine::Whisper(ctx) => {
                let app_prog = app.clone();
                let progress_generation = state.audio_generation.clone();
                tokio::task::spawn_blocking(move || {
                    transcribe::transcribe_local(
                        &ctx,
                        &samples,
                        prompt.as_deref(),
                        language.as_deref(),
                        // The capsule only communicates status, never transcript text.
                        |_| {},
                        move |progress| {
                            if progress_generation.load(Ordering::SeqCst) == generation {
                                let _ =
                                    app_prog.emit_to("capsule", "capsule-stt-progress", progress);
                            }
                        },
                    )
                    .map(transcribe::Transcription::from)
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))?
            }
            #[cfg(feature = "parakeet")]
            LocalEngine::Parakeet(engine) => {
                // Parakeet has no vocabulary prompt; dictionary words reach it as
                // CTC keyword-spotter terms once those models are loaded.
                let _ = prompt;
                let terms = vocabulary.unwrap_or_default();
                tokio::task::spawn_blocking(move || {
                    if !terms.is_empty() && engine.has_vocabulary_models() {
                        transcribe::transcribe_parakeet_with_vocabulary(
                            &engine,
                            &samples,
                            language.as_deref(),
                            &terms,
                        )
                    } else {
                        transcribe::transcribe_parakeet(&engine, &samples, language.as_deref())
                            .map(transcribe::Transcription::from)
                    }
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))?
            }
        }
    }
    #[cfg(not(feature = "local-stt"))]
    {
        let _ = (app, state, prompt, language, filename);
        Err("Local STT not available — rebuild with `local-stt` feature".into())
    }
}

#[tauri::command]
fn stop_correction_watch() {
    #[cfg(target_os = "macos")]
    {
        corrections::stop();
    }
}

#[tauri::command]
fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        fnkey::is_accessibility_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        fnkey::request_accessibility_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn reinit_fn_key_monitor(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        fnkey::reinit_monitor_if_needed(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Point the modifier-hold monitor at a different trigger key
/// (fn, right-command, left-option, ...). Invalid names are rejected.
#[tauri::command]
fn set_trigger_modifier(modifier: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        fnkey::set_trigger_modifier(&modifier)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = modifier;
        Ok(())
    }
}

/// Detect whether the fn key is also bound to a macOS system action.
/// Linty's NSEvent monitors are observe-only, so a system binding (Dictation,
/// emoji picker) fires alongside push-to-talk — the cause of double-pasted
/// dictations (issue #32). Only AppleFnUsageType == 0 ("Do Nothing") is safe.
#[tauri::command]
fn check_fn_key_conflict() -> FnKeyConflict {
    #[cfg(target_os = "macos")]
    {
        let usage_type = fnkey::fn_usage_type();
        FnKeyConflict {
            usage_type,
            conflict: usage_type != Some(0),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        FnKeyConflict {
            usage_type: None,
            conflict: false,
        }
    }
}

/// Force-reinitialize the fn key monitor (tears down + re-creates). Called on system wake.
#[tauri::command]
fn force_reinit_fn_key_monitor(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        fnkey::force_reinit_monitor(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Open a macOS System Settings pane via NSWorkspace.
/// Bypasses Tauri shell plugin URL validation which blocks x-apple.systempreferences: URLs.
#[tauri::command]
fn open_system_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        unsafe {
            let objc_get_class: unsafe extern "C" fn(*const u8) -> *const c_void =
                fnkey_ffi::objc_getClass;
            let sel_register: unsafe extern "C" fn(*const u8) -> *const c_void =
                fnkey_ffi::sel_registerName;

            // Create NSURL from string
            let ns_string_class = objc_get_class(b"NSString\0".as_ptr());
            let url_bytes = format!("{}\0", pane);
            let alloc_sel = sel_register(b"stringWithUTF8String:\0".as_ptr());
            let send_str: unsafe extern "C" fn(
                *const c_void,
                *const c_void,
                *const u8,
            ) -> *const c_void = std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
            let ns_string = send_str(ns_string_class, alloc_sel, url_bytes.as_ptr());

            let nsurl_class = objc_get_class(b"NSURL\0".as_ptr());
            let url_sel = sel_register(b"URLWithString:\0".as_ptr());
            let send_url: unsafe extern "C" fn(
                *const c_void,
                *const c_void,
                *const c_void,
            ) -> *const c_void = std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
            let nsurl = send_url(nsurl_class, url_sel, ns_string);

            if nsurl.is_null() {
                return Err(format!("Invalid URL: {}", pane));
            }

            // [[NSWorkspace sharedWorkspace] openURL:nsurl]
            let ws_class = objc_get_class(b"NSWorkspace\0".as_ptr());
            let shared_sel = sel_register(b"sharedWorkspace\0".as_ptr());
            let send_ws: unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void =
                std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
            let workspace = send_ws(ws_class, shared_sel);

            let open_sel = sel_register(b"openURL:\0".as_ptr());
            let send_open: unsafe extern "C" fn(
                *const c_void,
                *const c_void,
                *const c_void,
            ) -> bool = std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
            let opened = send_open(workspace, open_sel, nsurl);

            if opened {
                Ok(())
            } else {
                Err(format!("Failed to open: {}", pane))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Ok(())
    }
}

// Re-export FFI symbols for use in open_system_settings
#[cfg(target_os = "macos")]
mod fnkey_ffi {
    use std::ffi::c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        pub fn objc_getClass(name: *const u8) -> *const c_void;
        pub fn sel_registerName(name: *const u8) -> *const c_void;
        pub fn objc_msgSend();
    }
}

// ── Microphone permission commands (macOS: AVFoundation, other: stub) ──

#[tauri::command]
fn check_microphone() -> String {
    #[cfg(target_os = "macos")]
    {
        permissions::check_microphone_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

#[tauri::command]
async fn request_microphone() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Must run off the main thread — blocking the main thread prevents
        // macOS from displaying the TCC permission prompt.
        tokio::task::spawn_blocking(|| permissions::request_microphone_permission())
            .await
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// ── Reset all data ──

// Deletes multi-GB model files — must not run on the main thread.
#[tauri::command(async)]
fn reset_all_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    history: tauri::State<'_, history::HistoryState>,
) -> Result<(), String> {
    app.state::<reformat::ReformatState>().cancel();
    app.state::<reformat::ReformatState>()
        .unload_if_idle(u64::MAX, 1);
    let _history_lock = history.0.lock().map_err(|e| e.to_string())?;
    history.forget_audio_consent();
    {
        let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
        rec.history_audio = None;
        rec.audio_consent = None;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;

    // Delete settings store
    legacy_settings::remove_retired_settings(&app)?;
    let settings_path = data_dir.join("linty-settings.json");
    if settings_path.exists() {
        std::fs::remove_file(&settings_path)
            .map_err(|e| format!("Failed to delete settings: {}", e))?;
        log::info!("[reset] Deleted settings store");
    }

    // Delete history, corrections and dictionary stores, and the crash marker
    for (name, label) in [
        ("linty-history.json", "history store"),
        (history_db::DATABASE, "history database"),
        ("linty-history.sqlite3-journal", "history journal"),
        ("linty-corrections.json", "corrections store"),
        ("linty-dictionary.json", "dictionary store"),
        (logging::CRASH_MARKER, "crash marker"),
    ] {
        let path = data_dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete {}: {}", label, e))?;
            log::info!("[reset] Deleted {}", label);
        }
    }

    // Delete all downloaded models
    let models_dir = data_dir.join("models");
    if models_dir.exists() {
        std::fs::remove_dir_all(&models_dir)
            .map_err(|e| format!("Failed to delete models: {}", e))?;
        log::info!("[reset] Deleted models directory");
    }

    // Unload any local model from memory
    #[cfg(feature = "local-stt")]
    {
        state.unload_local_models();
        if let Ok(mut name) = state.local_model_filename.lock() {
            *name = None;
        }
        state.local_model_last_used_at.store(0, Ordering::Relaxed);
        log::info!("[reset] Unloaded local model");
    }
    #[cfg(not(feature = "local-stt"))]
    {
        let _ = &state;
    }

    log::info!("[reset] All data cleared — app will reload");
    audio_input::reset(&app);
    Ok(())
}

// ── Local STT commands ──

/// App icons for the given bundle ids as PNG data URLs (None when unresolvable).
/// Synchronous on purpose: it runs on the main thread, where AppKit's
/// NSWorkspace/NSImage calls belong. Results are cached for the app's lifetime.
#[tauri::command]
fn get_app_icons(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bundle_ids: Vec<String>,
) -> std::collections::HashMap<String, Option<String>> {
    use base64::Engine as _;
    let mut cache = state
        .app_icon_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut icons = std::collections::HashMap::with_capacity(bundle_ids.len());
    for bundle_id in bundle_ids {
        let icon = cache
            .entry(bundle_id.clone())
            .or_insert_with(|| {
                // Always use this build's Linty icon. NSWorkspace may resolve an
                // older installed copy while a newer local build is running.
                let png = if bundle_id == app.config().identifier {
                    Some(include_bytes!("../icons/128x128.png").to_vec())
                } else {
                    application::app_icon_png(&bundle_id)
                };
                png.map(|png| {
                    format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(png)
                    )
                })
            })
            .clone();
        icons.insert(bundle_id, icon);
    }
    icons
}

#[tauri::command]
fn get_available_models() -> Vec<transcribe::ModelInfo> {
    #[cfg(feature = "parakeet")]
    let parakeet_supported = parakeet::is_supported();
    #[cfg(not(feature = "parakeet"))]
    let parakeet_supported = false;
    transcribe::available_models(parakeet_supported)
}

/// The capsule needs the appearance preference, not general store access.
#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store("linty-settings.json")
        .map_err(|e| e.to_string())?;
    let value = store.get("theme");
    Ok(match value.as_ref().and_then(|value| value.as_str()) {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
    .into())
}

#[tauri::command]
fn get_models_dir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
    let models_dir = data_dir.join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    Ok(models_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn check_model_exists(app: tauri::AppHandle, filename: String) -> Result<bool, String> {
    let model_path = model_store::speech_path(&models_dir(&app)?, &filename)?;
    if transcribe::is_parakeet_model(&filename) {
        // A Parakeet bundle is a directory of CoreML models; only count it
        // when every required file is present (a partial download is not usable).
        #[cfg(feature = "parakeet")]
        return Ok(parakeet::models_exist(&model_path));
        #[cfg(not(feature = "parakeet"))]
        return Ok(false);
    }
    Ok(model_path.exists())
}

#[tauri::command]
async fn download_model_file(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let dest = model_store::speech_path(&models_dir(&app)?, &filename)?;

    if transcribe::is_parakeet_model(&filename) {
        #[cfg(feature = "parakeet")]
        {
            // FluidAudio fetches the multi-file CoreML bundle itself and
            // reports a 0–1 fraction covering download + Neural Engine compile.
            let app_progress = app.clone();
            let progress_filename = filename.clone();
            let dir = dest.clone();
            tokio::task::spawn_blocking(move || {
                let mut last_pct: i64 = -1;
                parakeet::download(&dir, |fraction| {
                    let pct = (fraction.clamp(0.0, 1.0) * 100.0) as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        let _ = app_progress.emit(
                            "model-download-progress",
                            serde_json::json!({
                                "filename": progress_filename,
                                "downloaded": pct,
                                "total": 100,
                                "progress": pct,
                            }),
                        );
                    }
                })
            })
            .await
            .map_err(|e| format!("Task join error: {}", e))??;
            let _ = app.emit(
                "model-download-complete",
                serde_json::json!({ "filename": filename }),
            );
            return Ok(dest.to_string_lossy().to_string());
        }
        #[cfg(not(feature = "parakeet"))]
        {
            return Err("This build does not include Parakeet support".to_string());
        }
    }

    transcribe::download_model(&app, &dest).await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn delete_model_file(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let model_path = model_store::speech_path(&models_dir(&app)?, &filename)?;
    if model_path.is_dir() {
        // Parakeet bundles are directories of .mlmodelc packages.
        std::fs::remove_dir_all(&model_path)
            .map_err(|e| format!("Failed to delete {}: {}", filename, e))?;
        log::info!("[cmd] Deleted model bundle: {}", filename);
    } else if model_path.exists() {
        std::fs::remove_file(&model_path)
            .map_err(|e| format!("Failed to delete {}: {}", filename, e))?;
        log::info!("[cmd] Deleted model: {}", filename);
    }
    Ok(())
}

/// Remove model binaries that are no longer offered in the catalog
/// (tiny/base, plus the 3.1 GB Large V3 and 1.6 GB full-precision Turbo
/// dropped in favour of Turbo Q5 + Parakeet).
fn cleanup_deprecated_models(app: &tauri::AppHandle) {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let models_dir = data_dir.join("models");
    for filename in &[
        "ggml-tiny.bin",
        "ggml-base.bin",
        "ggml-large-v3.bin",
        "ggml-large-v3-turbo.bin",
    ] {
        let path = models_dir.join(filename);
        if path.exists() {
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("[cleanup] Removed deprecated model: {}", filename),
                Err(e) => log::warn!("[cleanup] Failed to remove {}: {}", filename, e),
            }
        }
    }
}

/// Load a local model (whisper .bin or the Parakeet bundle) into memory and make
/// it the active engine for transcribe_buffer.
#[tauri::command]
async fn load_local_model(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] state: tauri::State<'_, AppState>,
    #[allow(unused_variables)] filename: String,
) -> Result<(), String> {
    log::info!("[cmd] load_local_model: {}", filename);
    #[cfg(feature = "local-stt")]
    {
        // Serialize with transcribe_buffer's lazy reload — never two loads at once
        let _load_guard = state.local_model_load_lock.lock().await;
        let _engine = load_local_engine(&app, &state, &filename).await?;
        {
            let mut name_guard = state
                .local_model_filename
                .lock()
                .map_err(|e| e.to_string())?;
            *name_guard = Some(filename.clone());
        }
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);

        prepare_installed_cleanup(&app, false).await?;

        log::info!("[cmd] Local model loaded successfully: {}", filename);
        Ok(())
    }
    #[cfg(not(feature = "local-stt"))]
    Err("Local STT not available — rebuild with `local-stt` feature".into())
}

/// Shared preparation during startup/capture, awaited before transcription.
/// Reuses warm instances; idle-unloaded instances follow the same load path.
#[tauri::command]
async fn prepare_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    filename: Option<String>,
    vocabulary: bool,
    cleanup_required: bool,
) -> Result<(), String> {
    #[cfg(feature = "local-stt")]
    {
        let _guard = state.local_model_load_lock.lock().await;
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);
        {
            let selected = state
                .local_model_filename
                .lock()
                .map_err(|e| e.to_string())?
                .clone();
            let filename = filename
                .or(selected.clone())
                .ok_or("Choose your dictation language in Settings → Language.")?;
            let engine = if selected.as_ref() == Some(&filename) {
                resident_local_engine(&state)?
            } else {
                None
            };
            let engine = match engine {
                Some(engine) => engine,
                None => {
                    let engine = load_local_engine(&app, &state, &filename).await?;
                    *state
                        .local_model_filename
                        .lock()
                        .map_err(|e| e.to_string())? = Some(filename);
                    engine
                }
            };
            #[cfg(feature = "parakeet")]
            if vocabulary {
                if let LocalEngine::Parakeet(engine) = engine {
                    let dir = model_store::vocabulary_path(&models_dir(&app)?)?;
                    tokio::task::spawn_blocking(move || engine.load_ctc(&dir))
                        .await
                        .map_err(|e| e.to_string())??;
                }
            }
            #[cfg(not(feature = "parakeet"))]
            let _ = (engine, vocabulary);
        }
        let result = prepare_installed_cleanup(&app, cleanup_required).await;
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);
        result
    }
    #[cfg(not(feature = "local-stt"))]
    {
        let _ = (app, state, filename, vocabulary, cleanup_required);
        Err("On-device speech support is not available in this build".into())
    }
}

async fn prepare_installed_cleanup(app: &tauri::AppHandle, required: bool) -> Result<(), String> {
    let status = reformat::s1_model_status(app.clone(), app.state())?;
    if status.downloaded {
        let result = reformat::prepare_s1_model(app.clone(), app.state()).await;
        if required {
            result
        } else {
            if result.is_err() {
                log::warn!("[dictation] Optional cleanup preparation failed");
            }
            Ok(())
        }
    } else if required {
        Err("Download S1-mini in Text cleanup settings before using AI autocorrection.".into())
    } else {
        Ok(())
    }
}

/// Download (first time, ~100 MB) and load the CTC keyword-spotter models that
/// let Parakeet recognise dictionary words. Returns true when a download happened.
#[tauri::command(async)]
async fn prepare_parakeet_vocabulary(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    #[cfg(feature = "parakeet")]
    {
        // Reloads the model after an idle unload, exactly like a dictation would.
        let engine = match resolve_local_engine(&app, &state).await? {
            LocalEngine::Parakeet(engine) => engine,
            LocalEngine::Whisper(_) => {
                return Err("Parakeet is not the selected engine".to_string())
            }
        };
        state
            .local_model_last_used_at
            .store(now_epoch_ms(), Ordering::Relaxed);
        if engine.has_vocabulary_models() {
            return Ok(false);
        }
        let dir = model_store::vocabulary_path(&models_dir(&app)?)?;
        let downloaded = !dir.is_dir();
        log::info!(
            "[stt] Preparing Parakeet vocabulary models in {}",
            dir.display()
        );
        let started = std::time::Instant::now();
        tokio::task::spawn_blocking(move || engine.load_ctc(&dir))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;
        log::info!(
            "[stt] Parakeet vocabulary models ready in {:.0}ms",
            started.elapsed().as_millis()
        );
        Ok(downloaded)
    }
    #[cfg(not(feature = "parakeet"))]
    Err("This build does not include Parakeet support".to_string())
}

/// Configure after how many minutes of inactivity the local model is unloaded
/// from memory (0 = never). Synced from the Settings UI on load and on change.
#[tauri::command]
fn set_model_idle_unload_minutes(
    #[allow(unused_variables)] state: tauri::State<'_, AppState>,
    #[allow(unused_variables)] minutes: u64,
) {
    #[cfg(feature = "local-stt")]
    {
        log::debug!("[cmd] set_model_idle_unload_minutes: {}", minutes);
        state
            .model_idle_unload_secs
            .store(minutes * 60, Ordering::Relaxed);
    }
}

#[tauri::command]
fn is_local_stt_available() -> bool {
    cfg!(feature = "local-stt")
}

// ── macOS: activation policy (Dock + menu bar visibility) ──

#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub(crate) fn set_activation_policy_regular() {
    use cocoa::appkit::{NSApp, NSApplication, NSApplicationActivationPolicy};
    unsafe {
        let app = NSApp();
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyRegular,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_activation_policy_regular() {}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub(crate) fn set_activation_policy_accessory() {
    use cocoa::appkit::{NSApp, NSApplication, NSApplicationActivationPolicy};
    unsafe {
        let app = NSApp();
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_activation_policy_accessory() {}

// ── macOS: System sleep/wake observer ──

#[cfg(target_os = "macos")]
fn register_wake_observer(app: &tauri::AppHandle, app_state: &AppState) {
    use std::ffi::c_void;

    // We need raw pointers to pass into the ObjC block
    struct SendAppHandle(tauri::AppHandle);
    unsafe impl Send for SendAppHandle {}
    unsafe impl Sync for SendAppHandle {}

    struct SendStatePtr(*const AppState);
    unsafe impl Send for SendStatePtr {}
    unsafe impl Sync for SendStatePtr {}

    // Leak the app handle and state pointer — they live for the lifetime of the process
    let app_handle = Box::leak(Box::new(SendAppHandle(app.clone())));
    let state_ptr = SendStatePtr(app_state as *const AppState);
    let state_ptr = Box::leak(Box::new(state_ptr));

    unsafe {
        let objc_get_class: unsafe extern "C" fn(*const u8) -> *const c_void =
            fnkey_ffi::objc_getClass;
        let sel_register: unsafe extern "C" fn(*const u8) -> *const c_void =
            fnkey_ffi::sel_registerName;

        // Get [NSWorkspace sharedWorkspace]
        let ws_class = objc_get_class(b"NSWorkspace\0".as_ptr());
        let shared_sel = sel_register(b"sharedWorkspace\0".as_ptr());
        let send_ws: unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void =
            std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
        let workspace = send_ws(ws_class, shared_sel);

        // Get [[NSWorkspace sharedWorkspace] notificationCenter]
        let nc_sel = sel_register(b"notificationCenter\0".as_ptr());
        let send_nc: unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void =
            std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
        let notification_center = send_nc(workspace, nc_sel);

        // Build the notification name: NSWorkspaceDidWakeNotification
        let ns_string_class = objc_get_class(b"NSString\0".as_ptr());
        let str_sel = sel_register(b"stringWithUTF8String:\0".as_ptr());
        let send_str: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const u8,
        ) -> *const c_void = std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);
        let wake_name = send_str(
            ns_string_class,
            str_sel,
            b"NSWorkspaceDidWakeNotification\0".as_ptr(),
        );

        // Build the ObjC block for the observer callback
        // Block signature: void (^)(NSNotification *)
        #[repr(C)]
        struct WakeBlockDescriptor {
            reserved: u64,
            size: u64,
        }

        #[repr(C)]
        struct WakeBlock {
            isa: *const c_void,
            flags: i32,
            reserved: i32,
            invoke: unsafe extern "C" fn(*mut WakeBlock, *const c_void),
            descriptor: *const WakeBlockDescriptor,
            app_handle: *const SendAppHandle,
            state_ptr: *const SendStatePtr,
        }

        extern "C" {
            static _NSConcreteStackBlock: *const c_void;
        }

        unsafe extern "C" fn wake_invoke(block: *mut WakeBlock, _notification: *const c_void) {
            log::info!("[wake] System/screen wake detected — reinitializing");

            let app = &(*(*block).app_handle).0;
            let state = &*(*(*block).state_ptr).0;

            // 1. Force reinit fn key monitors
            fnkey::force_reinit_monitor(app.clone());

            // 2. Re-apply capsule NSPanel properties (macOS may reset level/floating after sleep)
            capsule::reinit_capsule_properties(app);

            // 3. Drop stale audio_tx sender so a fresh audio thread is spawned next recording
            if let Ok(mut tx_guard) = state.audio_tx.lock() {
                *tx_guard = None;
            }

            // 4. Release stale audio buffer memory
            if let Ok(mut buf) = state.audio_buffer.lock() {
                *buf = Vec::new();
            }

            // 5. Reset recording state (prevents desync if recording was active during sleep)
            if let Ok(mut rec) = state.recording.lock() {
                rec.is_recording = false;
                rec.samples = Default::default();
                rec.history_audio = None;
                rec.audio_consent = None;
            }

            // 6. Emit system-wake event to frontend
            history::on_wake(app.clone());
            let _ = app.emit("system-wake", ());
        }

        static WAKE_DESCRIPTOR: WakeBlockDescriptor = WakeBlockDescriptor {
            reserved: 0,
            size: std::mem::size_of::<WakeBlock>() as u64,
        };

        let block = Box::new(WakeBlock {
            isa: _NSConcreteStackBlock,
            flags: 0,
            reserved: 0,
            invoke: wake_invoke,
            descriptor: &WAKE_DESCRIPTOR,
            app_handle: app_handle as *const SendAppHandle,
            state_ptr: state_ptr as *const SendStatePtr,
        });
        let block_ptr = Box::into_raw(block);

        // [notificationCenter addObserverForName:object:queue:usingBlock:]
        let add_sel = sel_register(b"addObserverForName:object:queue:usingBlock:\0".as_ptr());
        let send_add: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
            *const WakeBlock,
        ) -> *const c_void = std::mem::transmute(fnkey_ffi::objc_msgSend as *const c_void);

        let _observer = send_add(
            notification_center,
            add_sel,
            wake_name,
            std::ptr::null(), // object: nil (any sender)
            std::ptr::null(), // queue: nil (posting thread)
            block_ptr,
        );

        log::debug!("[wake] Registered NSWorkspaceDidWakeNotification observer");

        // Also listen for display-only sleep/wake (lid close while on power).
        // NSWorkspaceDidWakeNotification does NOT fire for screen-only wake.
        let screen_wake_name = send_str(
            ns_string_class,
            str_sel,
            b"NSWorkspaceScreensDidWakeNotification\0".as_ptr(),
        );

        // Reuse the same block layout — screen wake needs the same recovery steps.
        // We need a separate block instance since each observer owns its block.
        let screen_block = Box::new(WakeBlock {
            isa: _NSConcreteStackBlock,
            flags: 0,
            reserved: 0,
            invoke: wake_invoke,
            descriptor: &WAKE_DESCRIPTOR,
            app_handle: app_handle as *const SendAppHandle,
            state_ptr: state_ptr as *const SendStatePtr,
        });
        let screen_block_ptr = Box::into_raw(screen_block);

        let _screen_observer = send_add(
            notification_center,
            add_sel,
            screen_wake_name,
            std::ptr::null(),
            std::ptr::null(),
            screen_block_ptr,
        );

        log::debug!("[wake] Registered NSWorkspaceScreensDidWakeNotification observer");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered. A second launch (double-open,
        // updater relaunch overlapping the old process) would run its own
        // fn-key monitors and paste pipeline — an independent double-paste
        // vector. Instead, surface the already-running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("[single-instance] Second launch blocked — focusing existing window");
            set_activation_policy_regular();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Local-only log file; registered before every plugin that logs.
        .plugin(logging::plugin())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_nspanel::init())
        .manage(AppState::new())
        .manage(dictation::Coordinator::default())
        .manage(audio_input::AudioInputState::default())
        .manage(history::HistoryState::default())
        .manage(reformat::ReformatState::default())
        // macOS app menu bar (Linty + Edit)
        .menu(|app| {
            let about = PredefinedMenuItem::about(app, Some("About Linty"), None)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let reset = MenuItem::with_id(
                app,
                "reset-all-data",
                "Reset All Data...",
                true,
                None::<&str>,
            )?;
            let sep2_app = PredefinedMenuItem::separator(app)?;
            let quit = PredefinedMenuItem::quit(app, Some("Quit Linty"))?;
            let check_updates = MenuItem::with_id(
                app,
                "check-for-updates",
                "Check for Updates...",
                true,
                None::<&str>,
            )?;
            let settings =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let app_submenu = Submenu::with_items(
                app,
                "Linty",
                true,
                &[
                    &about,
                    &check_updates,
                    &sep,
                    &settings,
                    &reset,
                    &sep2_app,
                    &quit,
                ],
            )?;

            let undo = PredefinedMenuItem::undo(app, None)?;
            let redo = PredefinedMenuItem::redo(app, None)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let cut = PredefinedMenuItem::cut(app, None)?;
            let copy = PredefinedMenuItem::copy(app, None)?;
            let paste = PredefinedMenuItem::paste(app, None)?;
            let select_all = PredefinedMenuItem::select_all(app, None)?;
            let edit_submenu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[&undo, &redo, &sep2, &cut, &copy, &paste, &select_all],
            )?;

            Menu::with_items(app, &[&app_submenu, &edit_submenu])
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("menu-settings", ());
            }
            "reset-all-data" => {
                let _ = app.emit("menu-reset-all-data", ());
            }
            "check-for-updates" => {
                let _ = app.emit("menu-check-for-updates", ());
            }
            _ => {}
        })
        .setup(|app| {
            // Version banner, crash marker path and panic hook, before
            // anything else in setup can fail or panic.
            logging::init(app.handle());
            if let Err(error) = legacy_settings::remove_retired_settings(app.handle()) {
                log::warn!("[settings] Could not finish retired-settings cleanup: {error}");
            }
            #[cfg(target_os = "macos")]
            corrections::start(app.handle().clone());

            audio_input::init(app.handle())?;
            // Tray icon (menu, language selector, status)
            tray::init_tray(app)?;

            if let Some(window) = app.get_webview_window("main") {
                set_activation_policy_regular();
                let _ = window.show();
                let _ = window.center();
            }

            // Remove deprecated model binaries (tiny, base)
            cleanup_deprecated_models(app.handle());

            // Init NSPanel capsule overlay (macOS only)
            #[cfg(target_os = "macos")]
            capsule::init_capsule_panel(app.handle());

            // Start fn key monitor (macOS only — uses NSEvent)
            #[cfg(target_os = "macos")]
            fnkey::setup_fn_key_monitor(app.handle().clone());

            // Register sleep/wake observer (macOS only)
            #[cfg(target_os = "macos")]
            {
                let app_state = app.state::<AppState>();
                register_wake_observer(app.handle(), app_state.inner());
            }

            // Start resource watchdog (auto-recovery from CPU overload)
            history::initialize(app.handle().clone());
            watchdog::start(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide to tray instead of quitting
                let _ = window.hide();
                api.prevent_close();
                set_activation_policy_accessory();
            }
        })
        .invoke_handler(tauri::generate_handler![
            updater::check_for_update,
            dictation::start_dictation,
            dictation::stop_dictation,
            dictation::dictation_result,
            reformat::s1_model_status,
            reformat::download_s1_model,
            reformat::prepare_s1_model,
            reformat::unload_s1_model,
            reformat::cancel_reformatting,
            history::history_snapshot,
            history::history_query,
            history::history_get,
            history::history_patch,
            history::history_delete,
            history::history_restore,
            history::history_clear,
            history::history_retention_preview,
            history::history_set_retention,
            history::history_usage,
            history::history_usage_summary,
            history::history_corrections,
            history::history_add_correction,
            history::history_export,
            history::history_set_save_audio,
            history::history_audio,
            history::history_delete_audio,
            history::history_export_audio,
            audio_input::get_audio_inputs,
            audio_input::set_audio_input,
            recover_recording,
            stop_correction_watch,
            check_accessibility,
            request_accessibility,
            reinit_fn_key_monitor,
            force_reinit_fn_key_monitor,
            check_fn_key_conflict,
            set_trigger_modifier,
            open_system_settings,
            check_microphone,
            request_microphone,
            get_app_icons,
            get_available_models,
            get_theme,
            get_models_dir,
            check_model_exists,
            download_model_file,
            delete_model_file,
            is_local_stt_available,
            set_model_idle_unload_minutes,
            load_local_model,
            prepare_dictation,
            prepare_parakeet_vocabulary,
            reset_all_data,
            capsule::show_capsule,
            capsule::hide_capsule,
            capsule::emit_capsule_state,
            capsule::show_correction_feedback,
            capsule::play_capsule_sound,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Linty");
}
