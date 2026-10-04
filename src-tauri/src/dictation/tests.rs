use super::*;
use crate::{delivery::Delivery, transcribe::Transcription};

struct FakeBackend {
    raw: String,
    candidate: String,
    delivery_status: &'static str,
    record: Mutex<Option<Value>>,
    events: Mutex<Vec<&'static str>>,
    cancel: Option<Arc<Session>>,
    fail_save: bool,
    ready: Notify,
    delivery_started: Notify,
    delivery_gate: Option<Arc<Notify>>,
    delivery_order: Option<Arc<Mutex<Vec<String>>>>,
}
impl FakeBackend {
    fn new(raw: &str, candidate: &str) -> Self {
        Self {
            raw: raw.into(),
            candidate: candidate.into(),
            delivery_status: "verified",
            record: Mutex::new(None),
            events: Mutex::new(vec![]),
            cancel: None,
            fail_save: false,
            ready: Notify::new(),
            delivery_started: Notify::new(),
            delivery_gate: None,
            delivery_order: None,
        }
    }
    fn note(&self, event: &'static str) {
        self.events.lock().unwrap().push(event);
    }
}
impl Backend for FakeBackend {
    fn stage(&self, s: &Session, _: &str) -> Result<(), String> {
        s.check()
    }
    async fn prepare(&self, _: &Options) -> Result<(), String> {
        self.note("prepare");
        Ok(())
    }
    async fn transcribe(&self, _: &Options) -> Result<Transcription, String> {
        self.note("transcribe");
        Ok(Transcription::from(self.raw.clone()))
    }
    async fn cleanup(
        &self,
        text: String,
        language: String,
        options: reformat::Options,
    ) -> Result<reformat::ReformatResult, String> {
        self.note("cleanup");
        if let Some(s) = &self.cancel {
            s.cancelled.store(true, Ordering::SeqCst);
        }
        let mut metrics = reformat::Metrics::new(&text, &language, options);
        metrics.status = "applied".into();
        Ok(reformat::ReformatResult {
            text: self.candidate.clone(),
            metrics,
        })
    }
    fn cancel_cleanup(&self) {}
    async fn save(&self, record: Value, _: u64) -> Result<(), String> {
        self.note("save");
        assert_eq!(record["rawText"], self.raw);
        assert_eq!(record["finalText"], self.raw);
        if self.fail_save {
            return Err("synthetic full disk".into());
        }
        *self.record.lock().unwrap() = Some(record);
        Ok(())
    }
    async fn update(&self, _: String, record: Value) -> Result<(), String> {
        self.note("update");
        *self.record.lock().unwrap() = Some(record);
        self.ready.notify_one();
        Ok(())
    }
    async fn remove(&self, _: String) -> Result<(), String> {
        self.note("remove");
        *self.record.lock().unwrap() = None;
        Ok(())
    }
    async fn deliver(&self, s: Arc<Session>, _: String, text: String) -> Result<Delivery, String> {
        s.check()?;
        self.note("deliver");
        if let Some(order) = &self.delivery_order {
            order.lock().unwrap().push(text.clone());
        }
        self.delivery_started.notify_one();
        if let Some(gate) = &self.delivery_gate {
            gate.notified().await;
        }
        if !self.fail_save {
            let records = self.record.lock().unwrap();
            let record = records
                .as_ref()
                .expect("Text must be saved before delivery");
            assert_eq!(record["rawText"], self.raw);
            assert_eq!(record["finalText"], text);
            assert_eq!(record["deliveryStatus"], "pending");
        }
        Ok(Delivery {
            status: self.delivery_status,
            command_posted: self.delivery_status != "failed",
            command_posted_ms: Some(1.),
            insertion_observed_ms: (self.delivery_status == "verified").then_some(2.),
            reason: None,
        })
    }
    fn changed(&self) {}
}
fn session() -> Arc<Session> {
    let options=serde_json::from_value(json!({"filename":"test.bin","modelName":"Synthetic","language":"en","prompt":"","vocabulary":[],"dictionary":[],"cleanup":true,"cleanupOptions":{"styling":"semi-formal","structure":"lists","context":"general"},"cleanupContextAuto":false,"observeCorrections":false,"trackApplication":false})).unwrap();
    let s = Coordinator::default().reserve(options).unwrap();
    s.generation.store(7, Ordering::SeqCst);
    *s.phase.lock().unwrap() = Phase::Processing;
    s
}
async fn run(backend: &FakeBackend, s: &Arc<Session>) -> Result<Outcome, String> {
    process(
        backend,
        s,
        StopResult {
            sample_count: 16000,
            duration_secs: 1.,
            recording_generation: 7,
            application: None,
        },
        Instant::now(),
        0.,
        None,
    )
    .await
}
fn spawn_pipeline(
    backend: Arc<FakeBackend>,
    s: Arc<Session>,
    previous: Option<Arc<Session>>,
) -> tokio::task::JoinHandle<Result<Outcome, String>> {
    tokio::spawn(async move {
        let result = process(
            backend.as_ref(),
            &s,
            StopResult {
                sample_count: 16000,
                duration_secs: 1.,
                recording_generation: s.generation.load(Ordering::SeqCst),
                application: None,
            },
            Instant::now(),
            0.,
            previous.as_deref(),
        )
        .await;
        s.finish(result.clone());
        result
    })
}
#[tokio::test]
async fn next_take_is_processed_during_paste_verification_and_delivered_in_order() {
    let first = session();
    let second = session();
    let gate = Arc::new(Notify::new());
    let order = Arc::new(Mutex::new(vec![]));
    let mut a = FakeBackend::new("Please send the report", "Please send the report");
    a.delivery_gate = Some(gate.clone());
    a.delivery_order = Some(order.clone());
    let a = Arc::new(a);
    let mut b = FakeBackend::new("before Friday", "before Friday");
    b.delivery_order = Some(order.clone());
    let b = Arc::new(b);
    let first_work = spawn_pipeline(a.clone(), first.clone(), None);
    tokio::time::timeout(Duration::from_secs(1), a.delivery_started.notified())
        .await
        .unwrap();
    let second_work = spawn_pipeline(b.clone(), second, Some(first));
    tokio::time::timeout(Duration::from_secs(1), b.ready.notified())
        .await
        .unwrap();
    assert!(b.events.lock().unwrap().contains(&"cleanup"));
    assert!(!b.events.lock().unwrap().contains(&"deliver"));
    assert!(!first_work.is_finished());
    assert!(!second_work.is_finished());
    gate.notify_one();
    assert!(first_work.await.unwrap().is_ok());
    assert!(second_work.await.unwrap().is_ok());
    assert_eq!(
        *order.lock().unwrap(),
        vec!["Please send the report", "before Friday"]
    );
}
#[tokio::test]
async fn an_empty_or_failed_middle_take_cannot_allow_a_later_paste_to_overtake() {
    for fail_save in [false, true] {
        let first = session();
        let middle = session();
        let gate = Arc::new(Notify::new());
        let order = Arc::new(Mutex::new(vec![]));
        let mut a = FakeBackend::new("first", "first");
        a.delivery_gate = Some(gate.clone());
        a.delivery_order = Some(order.clone());
        let a = Arc::new(a);
        let first_work = spawn_pipeline(a.clone(), first.clone(), None);
        tokio::time::timeout(Duration::from_secs(1), a.delivery_started.notified())
            .await
            .unwrap();
        let mut b = FakeBackend::new(if fail_save { "middle" } else { "" }, "middle");
        b.fail_save = fail_save;
        let middle_work = spawn_pipeline(Arc::new(b), middle.clone(), Some(first));
        let mut c = FakeBackend::new("last", "last");
        c.delivery_order = Some(order.clone());
        let c = Arc::new(c);
        let last_work = spawn_pipeline(c.clone(), session(), Some(middle));
        tokio::time::timeout(Duration::from_secs(1), c.ready.notified())
            .await
            .unwrap();
        assert!(!middle_work.is_finished());
        assert!(!c.events.lock().unwrap().contains(&"deliver"));
        gate.notify_one();
        assert!(first_work.await.unwrap().is_ok());
        assert!(middle_work.await.unwrap().is_ok());
        assert!(last_work.await.unwrap().is_ok());
        assert_eq!(*order.lock().unwrap(), vec!["first", "last"]);
    }
}
#[tokio::test]
async fn non_english_skips_cleanup_and_preserves_delivery() {
    for (language, text) in [
        ("hi", "आप क्या कर रहे हो?"),
        ("hi", "Unexpected Latin output"),
        ("es", "¿Qué estás haciendo?"),
    ] {
        let b = FakeBackend::new(text, "This must never replace the transcript.");
        let mut s = session();
        Arc::get_mut(&mut s).unwrap().options.language = language.into();
        let result = run(&b, &s).await.unwrap();
        assert!(result.warnings.is_empty());
        let record = result.record.unwrap();
        assert_eq!(record["rawText"], text);
        assert_eq!(record["finalText"], text);
        assert_eq!(record["reformatting"]["enabled"], true);
        assert_eq!(record["reformatting"]["status"], "skipped");
        assert_eq!(record["reformatting"]["reason"], "unsupported_language");
        assert!(record.get("reformattedText").is_none());
        let events = b.events.lock().unwrap();
        assert!(!events.contains(&"cleanup"));
        assert!(events.contains(&"deliver"));
    }
}

#[tokio::test]
async fn raw_is_saved_before_cleanup_and_delivery_then_verification_is_recorded() {
    let b = FakeBackend::new("send Sara fifteen rupees", "Send Sara ₹15.");
    let result = run(&b, &session()).await.unwrap();
    assert_eq!(delivery_feedback(&result), ("done", None));
    let events = b.events.lock().unwrap();
    let index = |name| events.iter().position(|e| *e == name).unwrap();
    assert!(index("save") < index("cleanup"));
    assert!(index("save") < index("deliver"));
    let record = result.record.unwrap();
    assert_eq!(record["rawText"], b.raw);
    assert_eq!(record["finalText"], b.candidate);
    assert_eq!(record["deliveryStatus"], "verified");
    assert_eq!(record["reformatting"]["enabled"], true);
    assert_eq!(record["pastedText"], b.candidate);
}
#[tokio::test]
async fn corrected_numbers_and_dates_are_delivered_with_the_original_retained() {
    for (raw, candidate) in [
        ("Four licences—my bad—five licences", "Five licences."),
        (
            "we ship in April, my mistake, January",
            "We ship in January.",
        ),
        ("meet on Friday scratch that Monday", "Meet on Monday."),
    ] {
        let b = FakeBackend::new(raw, candidate);
        let result = run(&b, &session()).await.unwrap();
        let record = result.record.unwrap();
        assert_eq!(record["rawText"], b.raw);
        assert_eq!(record["finalText"], b.candidate);
        assert_eq!(record["reformattedText"], b.candidate);
        assert_eq!(record["pastedText"], b.candidate);
        assert_eq!(record["textValidation"]["status"], "accepted");
        assert_eq!(record["reformatting"]["status"], "applied");
        assert_eq!(record["deliveryStatus"], "verified");
        assert!(result.warnings.is_empty());
    }
}
#[tokio::test]
async fn changed_currency_falls_back_before_any_delivery() {
    let b = FakeBackend::new(
        "the budget is one lakh fifty thousand rupees",
        "The budget is $150,000.",
    );
    let result = run(&b, &session()).await.unwrap();
    let record = result.record.unwrap();
    assert_eq!(record["finalText"], b.raw);
    assert_eq!(record["textValidation"]["status"], "fallback");
    assert_eq!(
        record["textValidation"]["reasons"],
        json!(["units_changed"])
    );
    assert_eq!(record["reformatting"]["status"], "fallback");
    assert!(record.get("reformattedText").is_none());
    assert!(!result.warnings.is_empty());
}
#[tokio::test]
async fn filler_only_cleanup_removes_the_pending_record_without_pasting() {
    let b = FakeBackend::new("um uh", "");
    let result = run(&b, &session()).await.unwrap();
    assert!(result.record.is_none());
    assert!(b.record.lock().unwrap().is_none());
    assert!(!b.events.lock().unwrap().contains(&"deliver"));
}
#[tokio::test]
async fn cancellation_after_recognition_keeps_saved_raw_and_prevents_paste() {
    let s = session();
    let mut b = FakeBackend::new("keep this text", "Keep this text.");
    b.cancel = Some(s.clone());
    assert!(run(&b, &s).await.is_err());
    assert!(!b.events.lock().unwrap().contains(&"deliver"));
    assert_eq!(b.record.lock().unwrap().as_ref().unwrap()["rawText"], b.raw);
}
#[tokio::test]
async fn uncertain_delivery_is_never_retried_or_called_verified() {
    let mut b = FakeBackend::new("keep this text", "Keep this text.");
    b.delivery_status = "unverified";
    let result = run(&b, &session()).await.unwrap();
    assert!(result.warnings.is_empty());
    assert_eq!(delivery_feedback(&result), ("idle", None));
    let record = result.record.unwrap();
    assert_eq!(record["deliveryStatus"], "unverified");
    assert!(record.get("pastedText").is_none());
    assert_eq!(record["attemptedText"], b.candidate);
    assert!(record["releaseToInsertionMs"].is_null());
    assert_eq!(
        b.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| **e == "deliver")
            .count(),
        1
    );
}
#[tokio::test]
async fn a_storage_error_is_reported_with_the_recoverable_transcript() {
    let mut b = FakeBackend::new("keep this text", "Keep this text.");
    b.fail_save = true;
    let result = run(&b, &session()).await.unwrap();
    assert!(!result.warnings.is_empty());
    let record = result.record.unwrap();
    assert_eq!(record["rawText"], b.raw);
    assert_eq!(record["deliveryStatus"], "failed");
    assert!(!b.events.lock().unwrap().contains(&"deliver"));
}

#[tokio::test]
async fn failed_delivery_keeps_the_recovery_message_and_saved_text() {
    let mut b = FakeBackend::new("keep this text", "Keep this text.");
    b.delivery_status = "failed";
    let result = run(&b, &session()).await.unwrap();
    assert_eq!(
        delivery_feedback(&result),
        ("error", Some("Paste failed · copy from History".into()))
    );
    let record = result.record.unwrap();
    assert_eq!(record["deliveryStatus"], "failed");
    assert_eq!(record["finalText"], b.candidate);
    assert!(record.get("attemptedText").is_none());
    assert!(record.get("pastedText").is_none());
    assert_eq!(*b.record.lock().unwrap(), Some(record));
}
