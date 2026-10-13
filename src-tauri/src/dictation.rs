//! Native owners of dictations. Capture can overlap ordered background delivery.
//! UI commands observe a session; they do not
//! orchestrate inference, transformation, persistence or delivery.
use crate::{history, reformat, text_validation, StopResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

mod backend;
use backend::{Backend, NativeBackend};
mod dictionary;
use dictionary::{apply, Entry};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub filename: Option<String>,
    pub model_name: String,
    pub language: String,
    #[serde(default)]
    pub auto_detect_languages: Vec<String>,
    pub prompt: String,
    pub vocabulary: Vec<crate::vocabulary::VocabTerm>,
    pub dictionary: Vec<Entry>,
    pub cleanup: bool,
    pub cleanup_options: reformat::Options,
    pub cleanup_context_auto: bool,
    pub observe_corrections: bool,
    pub track_application: bool,
    /// Capture started by a modifier-hold press: the native session may close
    /// the microphone on that press's release without waiting for the webview.
    #[serde(default)]
    pub stop_on_trigger_release: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub record: Option<Value>,
    pub warnings: Vec<String>,
    pub recognized: Vec<String>,
    pub corrected: Vec<String>,
}
#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Starting,
    Recording,
    Stopping,
    Processing,
    Finished,
}
/// Mirrors the frontend gesture interpreter (`src/lib/dictation-trigger.ts`):
/// a hold of at least TAP_MS finishes on release; two presses within
/// DOUBLE_PRESS_MS form one gesture (hands-free latch).
const TAP_MS: u64 = 250;
const DOUBLE_PRESS_MS: u64 = 400;
/// The first press of a trigger gesture, in wall-clock milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Gesture {
    start_seq: u64,
    at: u64,
}
#[derive(Default)]
struct TriggerState {
    seq: u64,
    gesture: Option<Gesture>,
}
/// The trigger paths run inside the NSEvent monitor's `extern "C"` block, where
/// a panic aborts the process. A poisoned lock degrades to the UI-driven stop.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
struct Session {
    id: u64,
    generation: AtomicU64,
    options: Options,
    phase: Mutex<Phase>,
    cancelled: AtomicBool,
    changed: Notify,
    processing_done: AtomicBool,
    processing_changed: Notify,
    result: Mutex<Option<Result<Outcome, String>>>,
    /// The press that started this capture, when it may stop on release.
    trigger: Mutex<Option<Gesture>>,
    /// A qualifying release arrived before the microphone opened.
    stop_requested: AtomicBool,
    /// The capture result, shared by the native release stop and the UI stop.
    stop: Mutex<Option<Result<StopResult, String>>>,
}
impl Session {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("Dictation cancelled".into())
        } else {
            Ok(())
        }
    }
    async fn guard<T>(
        &self,
        seconds: f64,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let notified = self.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        self.check()?;
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs_f64(seconds), work) => {
                self.check()?;
                result.map_err(|_| "Dictation stage timed out. Your original text is kept when available.".to_string())?
            },
            _ = notified => { self.check()?; Err("Dictation interrupted".into()) }
        }
    }
    fn finish(&self, result: Result<Outcome, String>) {
        self.release_processing();
        *self.result.lock().unwrap() = Some(result);
        *self.phase.lock().unwrap() = Phase::Finished;
        self.changed.notify_waiters();
    }
    fn release_processing(&self) {
        self.processing_done.store(true, Ordering::SeqCst);
        self.processing_changed.notify_waiters();
    }
    /// Move from Recording to Stopping exactly once. The caller that wins
    /// closes the microphone; everyone else waits for its stored result.
    fn begin_stop(&self) -> bool {
        let mut phase = lock(&self.phase);
        if *phase != Phase::Recording {
            return false;
        }
        *phase = Phase::Stopping;
        true
    }
    fn record_stop(&self, result: Result<StopResult, String>) {
        *self.stop.lock().unwrap() = Some(result);
        self.changed.notify_waiters();
    }
    fn stopped(&self) -> Option<Result<StopResult, String>> {
        self.stop.lock().unwrap().clone()
    }
    /// Wait for the capture result stored by whichever caller stopped first.
    /// Cancellation or an early finish releases waiters instead of hanging them.
    async fn await_stop(&self) -> Result<StopResult, String> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self.stopped() {
                return result;
            }
            self.check()?;
            if *self.phase.lock().unwrap() == Phase::Finished {
                return Err("This dictation has already stopped".into());
            }
            notified.await;
        }
    }
    async fn wait_processing(&self) {
        loop {
            let notified = self.processing_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.processing_done.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
    async fn outcome(&self) -> Result<Outcome, String> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self.result.lock().map_err(|e| e.to_string())?.clone() {
                return result;
            }
            notified.await;
        }
    }
    fn stage(&self, app: &tauri::AppHandle, stage: &str) -> Result<(), String> {
        self.check()?;
        let generation = self.generation.load(Ordering::SeqCst);
        // Background work must not replace the newer capture's pill or dialog.
        if !app.state::<Coordinator>().is_current(generation) {
            return Ok(());
        }
        let _ = app.emit_to(
            "main",
            "dictation-stage",
            json!({"generation":generation,"stage":stage}),
        );
        #[cfg(target_os = "macos")]
        crate::capsule::emit_capsule_state(app.clone(), stage.into(), None, Some(generation), None);
        Ok(())
    }
}
#[derive(Default)]
pub struct Coordinator {
    sessions: Mutex<Vec<Arc<Session>>>,
    processing: Mutex<Option<Arc<Session>>>,
    next: AtomicU64,
    trigger: Mutex<TriggerState>,
}
impl Coordinator {
    fn reserve(&self, options: Options) -> Result<Arc<Session>, String> {
        if options.language == "auto" {
            let languages = &options.auto_detect_languages;
            if !(1..=3).contains(&languages.len())
                || languages
                    .iter()
                    .any(|code| code.is_empty() || code == "auto" || code.as_bytes().contains(&0))
                || languages
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != languages.len()
            {
                return Err("Choose one to three different languages for Auto-detect in Settings → Dictation before recording.".into());
            }
            #[cfg(feature = "local-stt")]
            if languages
                .iter()
                .any(|code| whisper_rs::get_lang_id(code).is_none())
            {
                return Err(
                    "Choose supported auto-detect languages in Settings → Dictation.".into(),
                );
            }
        }
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.iter().any(|s| {
            matches!(
                *s.phase.lock().unwrap(),
                Phase::Starting | Phase::Recording | Phase::Stopping
            )
        }) {
            return Err("A recording is already active".into());
        }
        // Retain recent results for readers that attach after another capture.
        // In-flight workers keep their sessions until completion; no audio is
        // retained in completed sessions.
        let mut finished = sessions
            .iter()
            .filter(|s| *s.phase.lock().unwrap() == Phase::Finished)
            .count();
        sessions.retain(|s| {
            if finished > 32 && *s.phase.lock().unwrap() == Phase::Finished {
                finished -= 1;
                false
            } else {
                true
            }
        });
        let session = Arc::new(Session {
            id: self.next.fetch_add(1, Ordering::SeqCst) + 1,
            generation: AtomicU64::new(0),
            options,
            phase: Mutex::new(Phase::Starting),
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            processing_done: AtomicBool::new(false),
            processing_changed: Notify::new(),
            result: Mutex::new(None),
            trigger: Mutex::new(None),
            stop_requested: AtomicBool::new(false),
            stop: Mutex::new(None),
        });
        sessions.push(session.clone());
        Ok(session)
    }
    fn get(&self, generation: u64) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|s| s.generation.load(Ordering::SeqCst) == generation)
            .cloned()
            .ok_or_else(|| "This dictation is no longer active".into())
    }
    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .last()
            .is_some_and(|s| s.generation.load(Ordering::SeqCst) == generation)
    }
    fn enqueue(&self, session: Arc<Session>) -> Option<Arc<Session>> {
        self.processing.lock().unwrap().replace(session)
    }
    fn active_session(&self) -> Option<Arc<Session>> {
        lock(&self.sessions)
            .iter()
            .rev()
            .find(|s| matches!(*lock(&s.phase), Phase::Starting | Phase::Recording))
            .cloned()
    }
    /// A capture is open or draining. The capsule page must not reload while
    /// it could be asked to present this capture.
    pub(crate) fn capture_active(&self) -> bool {
        lock(&self.sessions).iter().any(|s| {
            matches!(
                *lock(&s.phase),
                Phase::Starting | Phase::Recording | Phase::Stopping
            )
        })
    }
    /// A trigger key went down at `at` (wall-clock ms). The first press of a
    /// gesture is remembered until a capture binds to it. Like the frontend,
    /// which anchors its double-press window on the press that started the
    /// gesture, a second press within that window belongs to the pending
    /// gesture; presses during an open capture never start one.
    fn trigger_pressed(&self, at: u64) {
        let capturing = self.active_session().is_some();
        let mut trigger = lock(&self.trigger);
        trigger.seq += 1;
        let double_press = trigger
            .gesture
            .is_some_and(|pending| at.saturating_sub(pending.at) <= DOUBLE_PRESS_MS);
        if !double_press && !capturing {
            trigger.gesture = Some(Gesture {
                start_seq: trigger.seq,
                at,
            });
        }
    }
    /// Bind a capture to the gesture that started it. The gesture is consumed,
    /// so a later capture can never inherit a stale press.
    fn bind_trigger(&self, session: &Session) {
        let gesture = lock(&self.trigger).gesture.take();
        *lock(&session.trigger) = gesture;
    }
    /// A trigger key came up at `at`. Returns the recording session to stop
    /// natively, with the hold duration, when this release ends a hold of the
    /// press that started it. A qualifying release before the microphone opened
    /// is remembered on the session, under the phase lock that `start_dictation`
    /// reads it with, so the request cannot fall between the two.
    fn trigger_released(&self, at: u64) -> Option<(Arc<Session>, u64)> {
        let seq = lock(&self.trigger).seq;
        let session = self.active_session()?;
        let gesture = (*lock(&session.trigger))?;
        if gesture.start_seq != seq {
            return None;
        }
        let held = at.saturating_sub(gesture.at);
        if held < TAP_MS {
            return None;
        }
        let recording = {
            let phase = lock(&session.phase);
            match *phase {
                Phase::Recording => true,
                Phase::Starting => {
                    session.stop_requested.store(true, Ordering::SeqCst);
                    false
                }
                _ => false,
            }
        };
        recording.then_some((session, held))
    }
    pub fn cancel(&self) {
        for s in self.sessions.lock().unwrap().iter() {
            s.cancelled.store(true, Ordering::SeqCst);
            // A recording has no processing worker to complete it.
            let phase = *s.phase.lock().unwrap();
            if matches!(phase, Phase::Recording | Phase::Starting) {
                s.finish(Err("Dictation cancelled".into()));
            }
            s.changed.notify_waiters();
        }
    }
}

#[tauri::command]
pub async fn start_dictation(app: tauri::AppHandle, options: Options) -> Result<u64, String> {
    let session = app.state::<Coordinator>().reserve(options)?;
    if session.options.stop_on_trigger_release {
        app.state::<Coordinator>().bind_trigger(&session);
    }
    let result = crate::start_recording(
        app.clone(),
        app.state(),
        Some(session.options.track_application),
    )
    .await;
    match result {
        Ok(generation) => {
            session.generation.store(generation, Ordering::SeqCst);
            let mut phase = session.phase.lock().map_err(|e| e.to_string())?;
            if let Err(error) = session.check() {
                drop(phase);
                session.finish(Err(error.clone()));
                return Err(error);
            }
            *phase = Phase::Recording;
            // The trigger was already released while the microphone opened. Read
            // the request under the lock the release path stored it with.
            let stop_now = session.stop_requested.swap(false, Ordering::SeqCst);
            if stop_now {
                *phase = Phase::Stopping;
            }
            drop(phase);
            if stop_now {
                log::info!(
                    "[dictation] Capture {} stopped on trigger release before capture opened",
                    generation
                );
                let s = session.clone();
                let a = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = stop_session(a, s, false).await;
                });
            }
            // Native warm-up is shared with processing. Capture never waits for it.
            let s = session.clone();
            let a = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = s.guard(180., prepare(&a, &s.options)).await;
            });
            Ok(generation)
        }
        Err(error) => {
            session.finish(Err(error.clone()));
            Err(error)
        }
    }
}
// Preparation runs on its own task. `Session::guard` drops its future when the
// capture stops or times out; dropping a load mid-flight would release
// `local_model_load_lock` while the blocking load continues, and the next
// caller would start a second Parakeet load. Detached, the load keeps the lock
// until it finishes and later callers reuse the engine it publishes.
async fn prepare(app: &tauri::AppHandle, options: &Options) -> Result<(), String> {
    let app = app.clone();
    let filename = options.filename.clone();
    let vocabulary = !options.vocabulary.is_empty();
    let language = Some(options.language.clone());
    tauri::async_runtime::spawn(async move {
        crate::prepare_dictation(
            app.clone(),
            app.state(),
            filename,
            vocabulary,
            false,
            language,
        )
        .await
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn stop_dictation(
    app: tauri::AppHandle,
    generation: u64,
    discard: bool,
) -> Result<StopResult, String> {
    let session = app.state::<Coordinator>().get(generation)?;
    session.check()?;
    if session.begin_stop() {
        return stop_session(app, session, discard).await;
    }
    // The native trigger release may have closed the microphone first. Return
    // its result rather than failing the UI's own stop.
    let phase = *session.phase.lock().map_err(|e| e.to_string())?;
    match phase {
        Phase::Starting => Err("This dictation is still starting".into()),
        Phase::Stopping => session.await_stop().await,
        _ => session
            .stopped()
            .unwrap_or_else(|| Err("This dictation has already stopped".into())),
    }
}

/// Native trigger hooks (macOS modifier-hold monitor). Times are wall-clock ms.
#[cfg(target_os = "macos")]
pub fn trigger_pressed(app: &tauri::AppHandle, at: u64) {
    app.state::<Coordinator>().trigger_pressed(at);
}
/// Close the microphone on the release of the press that started the capture,
/// without waiting for a webview to react. The UI's later stop receives the
/// same result.
#[cfg(target_os = "macos")]
pub fn trigger_released(app: &tauri::AppHandle, at: u64) {
    let Some((session, held)) = app.state::<Coordinator>().trigger_released(at) else {
        return;
    };
    if !session.begin_stop() {
        return;
    }
    log::info!(
        "[dictation] Capture {} stopped on trigger release (held {} ms)",
        session.generation.load(Ordering::SeqCst),
        held
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = stop_session(app, session, false).await;
    });
}

/// Close the microphone for a capture already in `Stopping`, then hand its
/// samples to the background pipeline. Shared by the UI stop command and the
/// native trigger-release stop; the result is stored for whichever arrives second.
async fn stop_session(
    app: tauri::AppHandle,
    session: Arc<Session>,
    discard: bool,
) -> Result<StopResult, String> {
    let generation = session.generation.load(Ordering::SeqCst);
    let stopped = Instant::now();
    let result = session
        .guard(5., crate::stop_recording(app.clone(), app.state()))
        .await;
    let audio = match result {
        Ok(a) => a,
        Err(e) => {
            session.record_stop(Err(e.clone()));
            session.finish(Err(e.clone()));
            return Err(e);
        }
    };
    // Detach this capture before permitting the next one to clear recording
    // state. Inference owns the allocation independently of the microphone.
    let samples = match app.state::<crate::state::AppState>().recording.lock() {
        Ok(mut recording) => std::mem::take(&mut recording.samples),
        Err(e) => {
            let e = e.to_string();
            session.record_stop(Err(e.clone()));
            session.finish(Err(e.clone()));
            return Err(e);
        }
    };
    let previous = if !discard && audio.sample_count > 0 {
        app.state::<Coordinator>().enqueue(session.clone())
    } else {
        None
    };
    *session.phase.lock().unwrap() = Phase::Processing;
    session.record_stop(Ok(audio.clone()));
    log::info!(
        "[dictation] Capture {} stopped; background processing queued",
        generation
    );
    let audio_stop_ms = stopped.elapsed().as_secs_f64() * 1000.;
    if discard || audio.sample_count == 0 {
        let _ = history::history_discard_pending_audio(app.state(), generation);
        terminal(&app, &session, &Ok(Outcome::default()));
        session.finish(Ok(Outcome::default()));
    } else {
        let a = app.clone();
        let input = audio.clone();
        // Dropping the UI request cannot stop or repeat this worker.
        tauri::async_runtime::spawn(async move {
            let result = process(
                &NativeBackend {
                    app: a.clone(),
                    samples,
                    generation,
                },
                &session,
                input,
                stopped,
                audio_stop_ms,
                previous.as_deref(),
            )
            .await;
            let _ = history::history_discard_pending_audio(a.state(), generation);
            terminal(&a, &session, &result);
            session.finish(result);
        });
    }
    Ok(audio)
}
#[tauri::command]
pub async fn dictation_result(app: tauri::AppHandle, generation: u64) -> Result<Outcome, String> {
    let session = app.state::<Coordinator>().get(generation)?;
    session.outcome().await
}
fn delivery_feedback(outcome: &Outcome) -> (&'static str, Option<String>) {
    match outcome
        .record
        .as_ref()
        .and_then(|r| r["deliveryStatus"].as_str())
    {
        None | Some("skipped") => ("idle", None),
        Some("verified") => ("done", None),
        // Some apps accept paste without exposing readable Accessibility text.
        // Dismiss quietly; History retains the verification details.
        Some("unverified" | "pasted") => ("idle", None),
        Some("failed") => ("error", Some("Paste failed · copy from History".into())),
        _ => ("error", Some("Text ready · copy from History".into())),
    }
}
fn terminal(app: &tauri::AppHandle, session: &Session, result: &Result<Outcome, String>) {
    if session.check().is_err() {
        return;
    }
    let generation = session.generation.load(Ordering::SeqCst);
    if !app.state::<Coordinator>().is_current(generation) {
        return;
    }
    let (state, message) = match result {
        Ok(outcome) => delivery_feedback(outcome),
        Err(_) => ("error", Some("Dictation stopped · open Linty".into())),
    };
    #[cfg(target_os = "macos")]
    crate::capsule::emit_capsule_state(app.clone(), state.into(), None, Some(generation), message);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let handle = app.clone();
        // NSPanel ordering must run on AppKit's main thread. Check ownership
        // there too, so a queued timer cannot hide a newer session's panel.
        let _ = app.run_on_main_thread(move || {
            if handle.state::<Coordinator>().is_current(generation) {
                #[cfg(target_os = "macos")]
                crate::capsule::hide_capsule(handle, None, None, None);
            }
        });
    });
}
fn millis(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}
// A blocked archive must not hold a dictation forever. A timed-out blocking
// write may still finish; it can never resume this pipeline or initiate paste.
async fn persist(
    work: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| "History did not respond".to_string())?
}
async fn process<B: Backend>(
    backend: &B,
    s: &Arc<Session>,
    audio: StopResult,
    stopped: Instant,
    audio_stop_ms: f64,
    previous: Option<&Session>,
) -> Result<Outcome, String> {
    // Shared inference stays serialized, but earlier clipboard verification
    // does not hold up recognition of the next take.
    if let Some(previous) = previous {
        previous.wait_processing().await;
    }
    let result = process_text(backend, s, audio, stopped, audio_stop_ms, previous).await;
    s.release_processing();
    // Keep the delivery chain intact even if this take is empty or fails before
    // paste. A third take must still wait for the first one to finish delivery.
    if let Some(previous) = previous {
        let _ = previous.outcome().await;
    }
    result
}
async fn process_text<B: Backend>(
    backend: &B,
    s: &Arc<Session>,
    audio: StopResult,
    stopped: Instant,
    audio_stop_ms: f64,
    previous: Option<&Session>,
) -> Result<Outcome, String> {
    let o = &s.options;
    let mut outcome = Outcome::default();
    backend.stage(s, "preparing")?;
    let tick = Instant::now();
    s.guard(180., backend.prepare(o)).await?;
    let preparation_ms = millis(tick);
    backend.stage(s, "transcribing")?;
    let tick = Instant::now();
    let output = s
        .guard(
            (audio.duration_secs * 2. + 30.).max(60.),
            backend.transcribe(o),
        )
        .await?;
    let stt_ms = millis(tick);
    let raw = output.text;
    if raw.trim().is_empty() || raw.trim() == "[BLANK_AUDIO]" {
        return Ok(outcome);
    }
    let generation = s.generation.load(Ordering::SeqCst);
    let id = format!("t-{}-{}", crate::now_epoch_ms(), s.id);
    let mut record = json!({"transcriptId":id,"rawText":raw,"finalText":raw,
        "timestamp":crate::now_epoch_ms(),"durationSeconds":audio.duration_secs,"processingTimeMs":millis(stopped),
        "engine":"local","modelName":o.model_name,"speechModelId":o.filename,
        "transcriptionLanguage":o.language,"audioSampleCount":audio.sample_count,"application":audio.application,
        "wordCount":raw.split_whitespace().count(),"originalWordCount":raw.split_whitespace().count(),"corrected":false,
        "deliveryStatus":"pending","sttTimeMs":stt_ms,"audioStopTimeMs":audio_stop_ms,"preparationTimeMs":preparation_ms});
    record["reformatting"] = json!({"schemaVersion":1,"enabled":o.cleanup,
        "status":if o.cleanup {"fallback"} else {"disabled"},"options":o.cleanup_options,
        "requestedLanguage":o.language,"inputWords":raw.split_whitespace().count(),"outputWords":raw.split_whitespace().count(),
        "inputCharacters":raw.chars().count(),"outputCharacters":raw.chars().count(),"changed":false});
    // This write precedes every transformation and every delivery side effect.
    let saved = persist(backend.save(record.clone(), generation))
        .await
        .is_ok();
    if !saved {
        outcome.warnings.push(
            "Could not save this dictation to History. Automatic paste was skipped; copy your text before closing Linty.".into(),
        );
        record["deliveryStatus"] = json!("failed");
        outcome.record = Some(record);
        return Ok(outcome);
    }
    backend.changed();
    s.check()?;
    let mut candidate = raw.clone();
    let mut reformat_ms = 0.;
    if o.cleanup && !reformat::supports_language(&o.language) {
        record["reformatting"]["status"] = json!("skipped");
        record["reformatting"]["reason"] = json!("unsupported_language");
        record["reformatting"]["totalMs"] = json!(0.);
    } else if o.cleanup {
        backend.stage(s, "correcting")?;
        let tick = Instant::now();
        let mut options = o.cleanup_options.clone();
        if o.cleanup_context_auto
            && audio
                .application
                .as_ref()
                .and_then(|a| a.bundle_id.as_deref())
                .is_some_and(|id| {
                    [
                        "com.apple.mail",
                        "com.microsoft.Outlook",
                        "com.readdle.smartemail-Mac",
                    ]
                    .contains(&id)
                })
        {
            options.context = "email".into();
        }
        match s
            .guard(
                150.,
                backend.cleanup(raw.clone(), o.language.clone(), options),
            )
            .await
        {
            Ok(result) => {
                candidate = result.text;
                record["reformatting"] =
                    serde_json::to_value(&result.metrics).map_err(|e| e.to_string())?;
                record["reformatting"]["enabled"] = json!(true);
                if result.metrics.status == "applied" || result.metrics.status == "unchanged" {
                    record["reformattedText"] = json!(candidate);
                }
                if result.metrics.status == "fallback" {
                    outcome.warnings.push(
                        "Cleanup could not preserve the text. Your original transcript was kept."
                            .into(),
                    );
                }
            }
            Err(_) => {
                backend.cancel_cleanup();
                s.check()?;
                outcome
                    .warnings
                    .push("Cleanup did not finish. Your original transcript was kept.".into());
            }
        }
        reformat_ms = millis(tick);
        record["reformatting"]["roundTripMs"] = json!(reformat_ms);
    }
    let validation = text_validation::validate(&raw, &candidate);
    if validation.status == "fallback" {
        candidate = raw.clone();
        if o.cleanup {
            record.as_object_mut().unwrap().remove("reformattedText");
            record["reformatting"]["status"] = json!("fallback");
            record["reformatting"]["reason"] = json!(validation.reasons.join(", "));
            record["reformatting"]["changed"] = json!(false);
            record["reformatting"]["outputWords"] = json!(raw.split_whitespace().count());
            record["reformatting"]["outputCharacters"] = json!(raw.chars().count());
        }
        outcome
            .warnings
            .push("Cleanup changed protected details. Your original transcript was kept.".into());
    }
    record["textValidation"] = serde_json::to_value(validation).unwrap();
    if candidate.trim().is_empty() {
        record["deliveryStatus"] = json!("skipped");
        record["finalText"] = json!("");
        record["wordCount"] = json!(0);
        if saved {
            let _ = persist(backend.remove(id)).await;
        }
        return Ok(outcome);
    }
    // Dictionary changes are intentional user-approved spellings. Validate each
    // replacement for facts, while permitting its explicitly configured name.
    let applied = apply(&candidate, &o.dictionary);
    candidate = applied.text;
    outcome.corrected = applied.ids;
    outcome.recognized = output
        .vocabulary_applied
        .iter()
        .filter_map(|a| {
            o.dictionary
                .iter()
                .find(|e| e.right == a.to)
                .map(|e| e.entry_id.clone())
        })
        .collect();
    let mut pairs = serde_json::to_value(output.vocabulary_applied)
        .unwrap()
        .as_array()
        .cloned()
        .unwrap_or_default();
    pairs.extend(applied.pairs);
    record["dictionaryApplied"] = json!(pairs);
    record["dictionaryValidation"] = json!(applied.rejected);
    record["finalText"] = json!(candidate);
    record["wordCount"] = json!(candidate.split_whitespace().count());
    record["corrected"] = json!(candidate != raw);
    record["reformatTimeMs"] = json!(reformat_ms);
    s.check()?;
    if saved
        && persist(backend.update(id.clone(), record.clone()))
            .await
            .is_err()
    {
        outcome.warnings.push("Could not save the finished text. Automatic paste was skipped; copy the text if you still need it.".into());
        record["deliveryStatus"] = json!("failed");
        outcome.record = Some(record);
        return Ok(outcome);
    }
    s.release_processing();
    if let Some(previous) = previous {
        let _ = previous.outcome().await;
    }
    backend.stage(s, "pasting")?;
    let tick = Instant::now();
    let delivery_start_ms = millis(stopped);
    // Once delivery starts, await its result even after cancellation. Never retry
    // an uncertain key event or abandon clipboard restoration.
    let delivery = backend
        .deliver(s.clone(), id.clone(), candidate.clone())
        .await?;
    record["releaseToInsertionMs"] = json!(delivery
        .insertion_observed_ms
        .map(|ms| delivery_start_ms + ms));
    record["deliveryStatus"] = json!(delivery.status);
    record["delivery"] = serde_json::to_value(&delivery).unwrap();
    if delivery.command_posted {
        record["attemptedText"] = json!(candidate);
    }
    if delivery.status == "verified" {
        record["pastedText"] = json!(candidate);
    }
    record["pasteTimeMs"] = json!(millis(tick));
    record["processingTimeMs"] = json!(millis(stopped));
    if saved && persist(backend.update(id, record.clone())).await.is_err() {
        outcome
            .warnings
            .push("Could not update the delivery result in History.".into());
    }
    backend.changed();
    outcome.record = Some(record);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> Options {
        serde_json::from_value(json!({
        "filename":"model.bin","modelName":"Fixture","language":"en","prompt":"", "vocabulary":[],"dictionary":[],
        "cleanup":false,"cleanupOptions":{"styling":"semi-formal","structure":"lists","context":"general"},"cleanupContextAuto":false,
        "observeCorrections":false,"trackApplication":false
    })).unwrap()
    }
    #[test]
    fn capture_overlaps_processing_and_results_keep_their_generation() {
        let c = Coordinator::default();
        let first = c.reserve(options()).unwrap();
        first.generation.store(10, Ordering::SeqCst);
        assert!(c.reserve(options()).is_err());
        *first.phase.lock().unwrap() = Phase::Stopping;
        assert!(
            c.reserve(options()).is_err(),
            "The stream must drain before another capture"
        );
        *first.phase.lock().unwrap() = Phase::Processing;
        let second = c.reserve(options()).unwrap();
        second.generation.store(11, Ordering::SeqCst);
        assert_eq!(c.get(10).unwrap().id, first.id);
        assert!(!c.is_current(10));
        assert!(c.is_current(11));
        assert_eq!(c.get(11).unwrap().id, second.id);
        first.finish(Ok(Outcome::default()));
        assert_eq!(
            c.get(10).unwrap().id,
            first.id,
            "Late readers receive the original result"
        );
        assert!(c.get(12).is_err());
        assert_eq!(first.options.language, "en");
    }
    #[test]
    fn auto_detect_requires_one_to_three_distinct_languages_before_capture() {
        for languages in [
            vec![],
            vec!["en", "hi", "ur", "fr"],
            vec!["en", "en"],
            vec!["auto"],
            vec![""],
        ] {
            let mut o = options();
            o.language = "auto".into();
            o.auto_detect_languages = languages.into_iter().map(String::from).collect();
            assert!(Coordinator::default().reserve(o).is_err());
        }
        for languages in [vec!["hi"], vec!["en", "hi"], vec!["en", "hi", "ta"]] {
            let mut o = options();
            o.language = "auto".into();
            o.auto_detect_languages = languages.into_iter().map(String::from).collect();
            assert!(Coordinator::default().reserve(o).is_ok());
        }
    }
    #[tokio::test]
    async fn cancelling_a_running_stage_drops_its_continuation() {
        let c = Coordinator::default();
        let s = c.reserve(options()).unwrap();
        *s.phase.lock().unwrap() = Phase::Processing;
        let copy = s.clone();
        let work = tokio::spawn(async move {
            copy.guard(5., std::future::pending::<Result<(), String>>())
                .await
        });
        c.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(1), work)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        let next = c.reserve(options()).unwrap();
        assert!(
            next.check().is_ok(),
            "Capture does not wait on cancelled background work"
        );
        c.cancel();
        s.finish(Err("cancelled".into()));
        assert!(c.reserve(options()).is_ok());
    }
    #[tokio::test]
    async fn timeouts_never_accept_late_results() {
        let c = Coordinator::default();
        let s = c.reserve(options()).unwrap();
        assert!(s
            .guard(0.001, async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(())
            })
            .await
            .is_err());
    }
    fn recording(c: &Coordinator, bind: bool) -> Arc<Session> {
        let s = c.reserve(options()).unwrap();
        if bind {
            c.bind_trigger(&s);
        }
        *s.phase.lock().unwrap() = Phase::Recording;
        s
    }
    #[test]
    fn a_held_trigger_stops_only_the_press_that_started_the_capture() {
        let c = Coordinator::default();
        c.trigger_pressed(1_000);
        let s = recording(&c, true);
        assert!(
            c.trigger_released(1_100).is_none(),
            "A quick tap waits for the double-press window in the frontend"
        );
        let (stopped, held) = c.trigger_released(1_400).unwrap();
        assert_eq!(stopped.id, s.id);
        assert_eq!(held, 400);
    }
    #[test]
    fn a_double_press_binds_the_first_press_and_never_stops_natively() {
        let c = Coordinator::default();
        c.trigger_pressed(0);
        c.trigger_pressed(300); // second tap: the frontend latches hands-free
        let s = recording(&c, true);
        assert_eq!(s.trigger.lock().unwrap().unwrap().start_seq, 1);
        assert!(c.trigger_released(900).is_none());
        // The press that finishes a latched session starts no gesture either.
        c.trigger_pressed(2_000);
        assert!(c.trigger.lock().unwrap().gesture.is_none());
        assert!(c.trigger_released(2_600).is_none());
    }
    #[test]
    fn a_press_soon_after_finishing_hands_free_starts_a_fresh_gesture() {
        let c = Coordinator::default();
        c.trigger_pressed(0);
        let latched = recording(&c, true);
        // The press that finishes a latched session starts no gesture...
        c.trigger_pressed(5_000);
        latched.finish(Ok(Outcome::default()));
        // ...and the next press 300 ms later is a new take for the frontend too,
        // not the second tap of a double press anchored on the finishing press.
        c.trigger_pressed(5_300);
        let next = recording(&c, true);
        assert_eq!(
            c.trigger_released(5_700).map(|(s, held)| (s.id, held)),
            Some((next.id, 400))
        );
    }
    #[test]
    fn a_release_before_capture_opens_requests_a_deferred_stop() {
        let c = Coordinator::default();
        c.trigger_pressed(0);
        let s = c.reserve(options()).unwrap();
        c.bind_trigger(&s);
        assert!(c.trigger_released(600).is_none());
        assert!(s.stop_requested.load(Ordering::SeqCst));
        assert!(
            !s.begin_stop(),
            "Nothing to close before the microphone opened"
        );
    }
    #[test]
    fn unbound_captures_and_later_gestures_ignore_trigger_releases() {
        let c = Coordinator::default();
        c.trigger_pressed(0);
        // Accelerator shortcuts and the microphone test never bind a press.
        let accelerator = recording(&c, false);
        assert!(c.trigger_released(500).is_none());
        accelerator.finish(Ok(Outcome::default()));
        c.trigger_pressed(5_000);
        let next = recording(&c, true);
        assert_eq!(
            c.trigger_released(5_300).map(|(s, held)| (s.id, held)),
            Some((next.id, 300))
        );
    }
    #[tokio::test]
    async fn the_second_stop_caller_receives_the_stored_result_and_cancel_releases_waiters() {
        let c = Coordinator::default();
        let s = recording(&c, false);
        assert!(s.begin_stop());
        assert!(!s.begin_stop(), "Only one caller closes the microphone");
        let waiter = {
            let s = s.clone();
            tokio::spawn(async move { s.await_stop().await })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        s.record_stop(Ok(StopResult {
            sample_count: 16000,
            duration_secs: 1.,
            recording_generation: 0,
            application: None,
        }));
        assert_eq!(waiter.await.unwrap().unwrap().sample_count, 16000);
        *s.phase.lock().unwrap() = Phase::Processing;
        let cancelled = recording(&c, false);
        assert!(cancelled.begin_stop());
        let waiter = {
            let s = cancelled.clone();
            tokio::spawn(async move { s.await_stop().await })
        };
        tokio::task::yield_now().await;
        c.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }
    #[test]
    fn cancelling_a_recording_finishes_without_a_worker() {
        let c = Coordinator::default();
        let s = c.reserve(options()).unwrap();
        *s.phase.lock().unwrap() = Phase::Recording;
        c.cancel();
        assert!(s.check().is_err());
        assert!(c.reserve(options()).is_ok());
    }

    #[tokio::test]
    async fn processing_queue_preserves_order_while_capture_remains_available() {
        let c = Coordinator::default();
        let first = c.reserve(options()).unwrap();
        *first.phase.lock().unwrap() = Phase::Processing;
        assert!(c.enqueue(first.clone()).is_none());
        let second = c.reserve(options()).unwrap();
        *second.phase.lock().unwrap() = Phase::Processing;
        let previous = c.enqueue(second.clone()).unwrap();
        assert_eq!(previous.id, first.id);
        let waiting = tokio::spawn(async move { previous.outcome().await });
        tokio::task::yield_now().await;
        assert!(
            !waiting.is_finished(),
            "Later delivery waits for earlier delivery"
        );
        let third = c.reserve(options()).unwrap();
        assert!(third.check().is_ok());
        first.finish(Ok(Outcome::default()));
        assert!(waiting.await.unwrap().is_ok());
        assert_eq!(c.enqueue(third).unwrap().id, second.id);
    }
}

#[cfg(test)]
#[path = "dictation/tests.rs"]
mod pipeline_tests;
