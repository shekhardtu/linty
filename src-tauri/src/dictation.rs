//! Native owner of one dictation. UI commands observe a session; they do not
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
    pub local: bool,
    pub filename: Option<String>,
    pub model_name: String,
    pub language: String,
    pub prompt: String,
    pub vocabulary: Vec<crate::vocabulary::VocabTerm>,
    pub dictionary: Vec<Entry>,
    pub cleanup: bool,
    pub cleanup_options: reformat::Options,
    pub cleanup_context_auto: bool,
    pub cloud_correction: bool,
    pub correction_prompt: String,
    pub observe_corrections: bool,
    pub track_application: bool,
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
    Processing,
    Finished,
}
struct Session {
    id: u64,
    generation: AtomicU64,
    options: Options,
    phase: Mutex<Phase>,
    cancelled: AtomicBool,
    changed: Notify,
    result: Mutex<Option<Result<Outcome, String>>>,
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
        *self.result.lock().unwrap() = Some(result);
        *self.phase.lock().unwrap() = Phase::Finished;
        self.changed.notify_waiters();
    }
    fn stage(&self, app: &tauri::AppHandle, stage: &str) -> Result<(), String> {
        self.check()?;
        let generation = self.generation.load(Ordering::SeqCst);
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
    current: Mutex<Option<Arc<Session>>>,
    next: AtomicU64,
}
impl Coordinator {
    fn reserve(&self, options: Options) -> Result<Arc<Session>, String> {
        let mut slot = self.current.lock().map_err(|e| e.to_string())?;
        if slot
            .as_ref()
            .is_some_and(|s| *s.phase.lock().unwrap() != Phase::Finished)
        {
            return Err("A dictation is already active".into());
        }
        let session = Arc::new(Session {
            id: self.next.fetch_add(1, Ordering::SeqCst) + 1,
            generation: AtomicU64::new(0),
            options,
            phase: Mutex::new(Phase::Starting),
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            result: Mutex::new(None),
        });
        *slot = Some(session.clone());
        Ok(session)
    }
    fn get(&self, generation: u64) -> Result<Arc<Session>, String> {
        self.current
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|s| s.generation.load(Ordering::SeqCst) == generation)
            .cloned()
            .ok_or_else(|| "This dictation is no longer active".into())
    }
    pub fn cancel(&self) {
        if let Some(s) = self.current.lock().unwrap().as_ref() {
            s.cancelled.store(true, Ordering::SeqCst);
            // A recording has no processing worker to complete it.
            let recording = *s.phase.lock().unwrap() == Phase::Recording;
            if recording {
                s.finish(Err("Dictation cancelled".into()));
            }
            s.changed.notify_waiters();
        }
    }
}

#[tauri::command]
pub async fn start_dictation(app: tauri::AppHandle, options: Options) -> Result<u64, String> {
    if !options.local {
        let key = crate::credentials::get_groq_api_key(app.clone())?;
        if key.trim().is_empty() {
            return Err("Add a Groq API key in Settings → Speech engine.".into());
        }
    }
    let session = app.state::<Coordinator>().reserve(options)?;
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
            drop(phase);
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
async fn prepare(app: &tauri::AppHandle, options: &Options) -> Result<(), String> {
    crate::prepare_dictation(
        app.clone(),
        app.state(),
        options.local,
        options.filename.clone(),
        !options.vocabulary.is_empty(),
        false,
    )
    .await
}

#[tauri::command]
pub async fn stop_dictation(
    app: tauri::AppHandle,
    generation: u64,
    discard: bool,
) -> Result<StopResult, String> {
    let session = app.state::<Coordinator>().get(generation)?;
    session.check()?;
    {
        let mut phase = session.phase.lock().map_err(|e| e.to_string())?;
        if *phase != Phase::Recording {
            return Err("This dictation has already stopped".into());
        }
        *phase = Phase::Processing;
    }
    let stopped = Instant::now();
    let result = session
        .guard(5., crate::stop_recording(app.clone(), app.state()))
        .await;
    let audio = match result {
        Ok(a) => a,
        Err(e) => {
            session.finish(Err(e.clone()));
            return Err(e);
        }
    };
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
                &NativeBackend { app: a.clone() },
                &session,
                input,
                stopped,
                audio_stop_ms,
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
    loop {
        let notified = session.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if let Some(result) = session.result.lock().map_err(|e| e.to_string())?.clone() {
            return result;
        }
        notified.await;
    }
}
fn terminal(app: &tauri::AppHandle, session: &Session, result: &Result<Outcome, String>) {
    if session.check().is_err() {
        return;
    }
    let generation = session.generation.load(Ordering::SeqCst);
    let (state, message) = match result {
        Ok(outcome) => match outcome
            .record
            .as_ref()
            .and_then(|r| r["deliveryStatus"].as_str())
        {
            None | Some("skipped") => ("idle", None),
            Some("verified") => ("done", None),
            Some("failed") => ("error", Some("Paste failed · copy from History".into())),
            _ => (
                "error",
                Some("Paste unconfirmed · check destination".into()),
            ),
        },
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
            if handle.state::<Coordinator>().get(generation).is_ok() {
                #[cfg(target_os = "macos")]
                crate::capsule::hide_capsule(handle, None);
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
        "engine":if o.local {"local"} else {"cloud"},"modelName":o.model_name,"speechModelId":o.filename,
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
    let mut correction_ms = 0.;
    let mut cloud_status = if o.cleanup {
        "superseded-by-s1"
    } else {
        "disabled"
    };
    if o.cleanup {
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
    } else if o.cloud_correction && !o.local {
        backend.stage(s, "correcting")?;
        let tick = Instant::now();
        match s
            .guard(20., backend.correct(&raw, &o.correction_prompt))
            .await
        {
            Ok(text) => {
                candidate = text;
                cloud_status = if candidate == raw {
                    "unchanged"
                } else {
                    "applied"
                };
            }
            Err(_) => {
                s.check()?;
                cloud_status = "fallback";
                outcome.warnings.push(
                    "Cloud cleanup did not finish. Your original transcript was kept.".into(),
                );
            }
        }
        correction_ms = millis(tick);
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
        if cloud_status == "applied" {
            cloud_status = "fallback";
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
    record["correctionTimeMs"] = json!(correction_ms);
    record["cloudRefinementStatus"] = json!(cloud_status);
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
        "local":true,"filename":"model.bin","modelName":"Fixture","language":"en","prompt":"", "vocabulary":[],"dictionary":[],
        "cleanup":false,"cleanupOptions":{"styling":"semi-formal","structure":"lists","context":"general"},"cleanupContextAuto":false,
        "cloudCorrection":false,"correctionPrompt":"","observeCorrections":false,"trackApplication":false
    })).unwrap()
    }
    #[test]
    fn only_one_active_session_and_old_generation_cannot_attach_to_new() {
        let c = Coordinator::default();
        let first = c.reserve(options()).unwrap();
        first.generation.store(10, Ordering::SeqCst);
        assert!(c.reserve(options()).is_err());
        first.finish(Ok(Outcome::default()));
        let second = c.reserve(options()).unwrap();
        second.generation.store(11, Ordering::SeqCst);
        assert!(c.get(10).is_err());
        assert_eq!(c.get(11).unwrap().id, second.id);
        assert_eq!(first.options.language, "en");
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
        assert!(
            c.reserve(options()).is_err(),
            "Cancellation cannot release an in-flight delivery owner"
        );
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
    #[test]
    fn cancelling_a_recording_finishes_without_a_worker() {
        let c = Coordinator::default();
        let s = c.reserve(options()).unwrap();
        *s.phase.lock().unwrap() = Phase::Recording;
        c.cancel();
        assert!(s.check().is_err());
        assert!(c.reserve(options()).is_ok());
    }
}

#[cfg(test)]
#[path = "dictation/tests.rs"]
mod pipeline_tests;
