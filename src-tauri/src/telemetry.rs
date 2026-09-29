//! Explicit, consent-gated PostHog events. No autocapture, replay, log upload,
//! machine identifiers, arbitrary properties, or disk-backed event queue.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri_plugin_store::StoreExt;
use tokio::sync::{watch, Notify};
use uuid::Uuid;

const SETTINGS: &str = "linty-settings.json";
const MAX_PENDING: usize = 64;
const MAX_AGE: Duration = Duration::from_secs(60);
const SAVE_ERROR: &str = "Sharing is off for this session where requested, but could not be saved. Retry before quitting.";
static TELEMETRY: OnceLock<Arc<Telemetry>> = OnceLock::new();

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    schema_version: u8,
    enabled: bool,
    installation_id: Option<String>,
}
impl Preferences {
    fn read(value: Option<Value>) -> Self {
        value
            .and_then(|v| serde_json::from_value::<Self>(v).ok())
            .filter(|p| {
                p.schema_version == 1
                    && (!p.enabled
                        || p.installation_id
                            .as_ref()
                            .is_some_and(|s| Uuid::parse_str(s).is_ok()))
            })
            .unwrap_or_default()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    available: bool,
    enabled: bool,
    decided: bool,
    epoch: u64,
}

#[derive(Clone, Copy, Deserialize, Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Page {
    Dashboard,
    History,
    Apps,
    Dictionary,
    Shortcuts,
    SystemCheck,
    Settings,
    About,
}
#[derive(Clone, Copy, Deserialize, Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Diagnostic {
    RecordingStart,
    RecordingStop,
    Preparation,
    Transcription,
    Cleanup,
    HistoryWrite,
    Delivery,
    FrontendError,
    FrontendRejection,
    FrontendRender,
    RustPanic,
}
#[derive(Clone, Copy, Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Verified,
    Unverified,
    Failed,
    NoSpeech,
    Cancelled,
    Skipped,
}
#[derive(Clone, Copy, Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SpeechEngine {
    Whisper,
    Parakeet,
    Other,
}
impl SpeechEngine {
    pub fn from_model(id: Option<&str>) -> Self {
        match id {
            Some("parakeet-tdt-0.6b-v3") => Self::Parakeet,
            Some(
                "ggml-small.bin"
                | "ggml-medium.bin"
                | "ggml-large-v3-turbo-q5_0.bin"
                | "ggml-large-v3-turbo.bin"
                | "ggml-large-v3.bin",
            ) => Self::Whisper,
            _ => Self::Other,
        }
    }
}
#[derive(Clone, Debug)]
pub enum Event {
    SessionStarted,
    OnboardingCompleted,
    PageViewed(Page),
    DictationFinished {
        outcome: Outcome,
        elapsed: Duration,
        processing: Option<Duration>,
        cleanup: bool,
        speech_engine: SpeechEngine,
    },
    Failure(Diagnostic),
}
impl Event {
    fn diagnostic(&self) -> bool {
        matches!(self, Self::Failure(_))
    }
    fn wire(&self, id: &str, version: &str) -> Value {
        let mut properties = json!({
            "$process_person_profile": false, "$geoip_disable": true,
            "$ip": "0.0.0.0", "schema_version": 1,
            "app_version": version, "platform": "macos", "architecture": std::env::consts::ARCH,
        });
        let name = match self {
            Self::SessionStarted => "app_session_started",
            Self::OnboardingCompleted => "onboarding_completed",
            Self::PageViewed(page) => {
                properties["page"] = json!(page);
                "page_viewed"
            }
            Self::DictationFinished {
                outcome,
                elapsed,
                processing,
                cleanup,
                speech_engine,
            } => {
                properties["outcome"] = json!(outcome);
                properties["elapsed_bucket"] = json!(match elapsed.as_secs() {
                    0..=9 => "under_10s",
                    10..=29 => "10_to_30s",
                    30..=59 => "30_to_60s",
                    60..=299 => "1_to_5m",
                    _ => "over_5m",
                });
                properties["cleanup_enabled"] = json!(cleanup);
                properties["speech_engine"] = json!(speech_engine);
                properties["processing_bucket"] = json!(processing.map(|d| match d.as_millis() {
                    0..=999 => "under_1s",
                    1000..=2999 => "1_to_3s",
                    3000..=9999 => "3_to_10s",
                    10000..=29999 => "10_to_30s",
                    _ => "over_30s",
                }));
                "dictation_finished"
            }
            Self::Failure(code) => {
                // Fixed labels only. Error messages can contain transcripts,
                // file paths and credentials; they never enter this interface.
                let label = json!(code);
                properties["$exception_list"] = json!([{
                    "type": "LintyFailure", "value": label,
                    "mechanism": { "type": "generic", "handled": !matches!(code, Diagnostic::RustPanic | Diagnostic::FrontendError | Diagnostic::FrontendRejection | Diagnostic::FrontendRender) }
                }]);
                properties["$exception_fingerprint"] = label;
                properties["$exception_level"] = json!("error");
                "$exception"
            }
        };
        json!({ "event": name, "distinct_id": id, "properties": properties,
            "timestamp": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default() })
    }
}

#[derive(Clone, Copy, Default)]
pub struct Ticket {
    epoch: Option<u64>,
}
struct Pending {
    epoch: u64,
    body: Value,
    created: Instant,
}
struct Gate {
    preferences: Preferences,
    epoch: u64,
    pending: VecDeque<Pending>,
    diagnostics_window: Instant,
    diagnostics_count: usize,
}
impl Gate {
    fn new(preferences: Preferences) -> Self {
        Self {
            preferences,
            epoch: 0,
            pending: VecDeque::new(),
            diagnostics_window: Instant::now(),
            diagnostics_count: 0,
        }
    }
    fn ticket(&self) -> Ticket {
        Ticket {
            epoch: self.preferences.enabled.then_some(self.epoch),
        }
    }
    fn valid(&self, epoch: u64) -> bool {
        self.preferences.enabled && epoch == self.epoch
    }
    fn apply(&mut self, preferences: Preferences) {
        if preferences.enabled != self.preferences.enabled
            || preferences.installation_id != self.preferences.installation_id
        {
            self.epoch += 1;
        }
        self.preferences = preferences;
        // Never retain a payload carrying the previous installation identifier.
        self.pending.clear();
    }
    fn enqueue(&mut self, ticket: Ticket, event: Event, version: &str) {
        let diagnostic = event.diagnostic();
        let Some(epoch) = ticket.epoch else {
            return;
        };
        if !self.valid(epoch) || self.pending.len() >= MAX_PENDING {
            return;
        }
        if diagnostic {
            if self.diagnostics_window.elapsed() >= Duration::from_secs(60) {
                self.diagnostics_window = Instant::now();
                self.diagnostics_count = 0;
            }
            if self.diagnostics_count >= 20 {
                return;
            }
            self.diagnostics_count += 1;
        }
        let Some(id) = self.preferences.installation_id.as_ref() else {
            return;
        };
        self.pending.push_back(Pending {
            epoch,
            body: event.wire(id, version),
            created: Instant::now(),
        });
    }
}

struct Config {
    token: String,
    endpoint: String,
    client: reqwest::Client,
}
impl Config {
    fn new(token: &str, host: &str) -> Option<Self> {
        if !token.starts_with("phc_")
            || token.len() <= 4
            || token.len() > 256
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return None;
        }
        // Cloud regions are chosen explicitly; there is no implicit transfer
        // to a different region if the configured host is missing or invalid.
        if !matches!(
            host.trim_end_matches('/'),
            "https://eu.i.posthog.com" | "https://us.i.posthog.com"
        ) {
            return None;
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .https_only(true)
            .build()
            .ok()?;
        Some(Self {
            token: token.into(),
            endpoint: format!("{}/i/v0/e/", host.trim_end_matches('/')),
            client,
        })
    }
}
struct Telemetry {
    gate: Mutex<Gate>,
    writes: Mutex<()>,
    config: Option<Config>,
    version: String,
    wake: Notify,
    changed: watch::Sender<u64>,
}
impl Telemetry {
    fn snapshot(&self) -> Snapshot {
        let g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            available: self.config.is_some(),
            enabled: g.preferences.enabled,
            decided: g.preferences.schema_version == 1,
            epoch: g.epoch,
        }
    }
    fn apply(&self, preferences: Preferences) {
        self.gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .apply(preferences);
        self.changed.send_modify(|v| *v += 1);
        self.wake.notify_one();
    }
    fn capture(&self, ticket: Ticket, event: Event) {
        if self.config.is_none() {
            return;
        }
        self.gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(ticket, event, &self.version);
        self.wake.notify_one();
    }
    fn update_consent(
        &self,
        enabled: bool,
        persist: impl FnOnce(&Preferences) -> Result<(), String>,
    ) -> Result<Snapshot, String> {
        let _write = self
            .writes
            .lock()
            .map_err(|_| "Could not save sharing preferences.")?;
        let old = self
            .gate
            .lock()
            .map_err(|_| "Could not save sharing preferences.")?
            .preferences
            .clone();
        if enabled && !old.enabled && self.config.is_none() {
            return Err("Sharing is unavailable in this build.".into());
        }
        // Revocation takes effect before any disk operation can fail. Enabling
        // waits until the explicit consent has been saved successfully.
        let mut restricted = old.clone();
        restricted.enabled &= enabled;
        if !restricted.enabled {
            restricted.installation_id = None;
        }
        self.apply(restricted.clone());
        let preferences = Preferences {
            schema_version: 1,
            enabled,
            installation_id: enabled.then(|| {
                restricted
                    .installation_id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string())
            }),
        };
        persist(&preferences)?;
        self.apply(preferences);
        if enabled && !old.enabled {
            let ticket = self.gate.lock().unwrap_or_else(|e| e.into_inner()).ticket();
            self.capture(ticket, Event::SessionStarted);
        }
        Ok(self.snapshot())
    }
    async fn run(self: Arc<Self>) {
        let Some(config) = self.config.as_ref() else {
            return;
        };
        let mut changed = self.changed.subscribe();
        loop {
            let notified = self.wake.notified();
            let pending = {
                let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
                changed.borrow_and_update();
                let mut next = None;
                while let Some(p) = gate.pending.pop_front() {
                    if gate.valid(p.epoch) && p.created.elapsed() < MAX_AGE {
                        next = Some(p);
                        break;
                    }
                }
                next
            };
            let Some(pending) = pending else {
                notified.await;
                continue;
            };
            let mut body = pending.body;
            body["api_key"] = json!(config.token);
            tokio::select! {
                biased;
                _ = changed.changed() => {}, // Cancel in-flight work on any consent change.
                _ = config.client.post(&config.endpoint).json(&body).send() => {},
            }
            // Best effort, no retries, no logging of payloads or server responses.
        }
    }
}

pub fn init(app: &tauri::AppHandle) {
    let config = Config::new(
        option_env!("LINTY_POSTHOG_PROJECT_TOKEN").unwrap_or(""),
        option_env!("LINTY_POSTHOG_HOST").unwrap_or(""),
    );
    let preferences = app
        .store(SETTINGS)
        .ok()
        .map(|s| Preferences::read(s.get("telemetry")))
        .unwrap_or_default();
    let (changed, _) = watch::channel(0);
    let telemetry = Arc::new(Telemetry {
        gate: Mutex::new(Gate::new(preferences)),
        writes: Mutex::new(()),
        config,
        version: app.package_info().version.to_string(),
        wake: Notify::new(),
        changed,
    });
    if TELEMETRY.set(telemetry.clone()).is_err() {
        return;
    }
    capture(ticket(), Event::SessionStarted);
    tauri::async_runtime::spawn(telemetry.run());
}
pub fn ticket() -> Ticket {
    TELEMETRY
        .get()
        .map(|t| t.gate.lock().unwrap_or_else(|e| e.into_inner()).ticket())
        .unwrap_or_default()
}
pub fn capture(ticket: Ticket, event: Event) {
    if let Some(t) = TELEMETRY.get() {
        t.capture(ticket, event);
    }
}
pub fn capture_panic() {
    let Some(t) = TELEMETRY.get().filter(|t| t.config.is_some()) else {
        return;
    };
    // A panic can occur while the telemetry lock is held. Never block or
    // recurse into a poisoned mutex from the local crash hook.
    if let Ok(mut gate) = t.gate.try_lock() {
        let ticket = gate.ticket();
        gate.enqueue(ticket, Event::Failure(Diagnostic::RustPanic), &t.version);
        t.wake.notify_one();
    }
}
pub fn revoke() {
    if let Some(t) = TELEMETRY.get() {
        let _write = t.writes.lock().unwrap_or_else(|e| e.into_inner());
        t.apply(Preferences::default());
    }
}

#[tauri::command]
pub fn telemetry_snapshot() -> Snapshot {
    TELEMETRY.get().map(|t| t.snapshot()).unwrap_or(Snapshot {
        available: false,
        enabled: false,
        decided: false,
        epoch: 0,
    })
}
#[tauri::command(async)]
pub fn telemetry_set_consent(app: tauri::AppHandle, enabled: bool) -> Result<Snapshot, String> {
    let t = TELEMETRY
        .get()
        .ok_or("Sharing is unavailable in this build.")?;
    t.update_consent(enabled, |preferences| {
        let store = app.store(SETTINGS).map_err(|_| SAVE_ERROR.to_owned())?;
        let previous = store.get("telemetry");
        store.set("telemetry", json!(preferences));
        if store.save().is_err() {
            match previous {
                Some(value) => store.set("telemetry", value),
                None => {
                    store.delete("telemetry");
                }
            }
            return Err(SAVE_ERROR.into());
        }
        Ok(())
    })
}
#[tauri::command]
pub fn telemetry_page_viewed(page: Page, epoch: u64) {
    capture(Ticket { epoch: Some(epoch) }, Event::PageViewed(page));
}
#[tauri::command]
pub fn telemetry_onboarding_completed(epoch: u64) {
    capture(Ticket { epoch: Some(epoch) }, Event::OnboardingCompleted);
}
#[tauri::command]
pub fn telemetry_frontend_error(code: Diagnostic, epoch: u64) {
    if matches!(
        code,
        Diagnostic::FrontendError | Diagnostic::FrontendRejection | Diagnostic::FrontendRender
    ) {
        capture(Ticket { epoch: Some(epoch) }, Event::Failure(code));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn enabled() -> Preferences {
        Preferences {
            schema_version: 1,
            enabled: true,
            installation_id: Some(Uuid::new_v4().to_string()),
        }
    }
    #[test]
    fn absent_corrupt_and_legacy_settings_never_imply_consent() {
        for value in [
            None,
            Some(json!({"trackApplicationUsage":true})),
            Some(json!({"schemaVersion":1,"enabled":true,"installationId":"device-name"})),
        ] {
            let p = Preferences::read(value);
            assert!(!p.enabled);
        }
        let p = enabled();
        assert_eq!(
            Preferences::read(Some(json!(p))).installation_id,
            p.installation_id
        );
    }
    #[test]
    fn no_backfill_after_enabling() {
        let mut g = Gate::new(Preferences::default());
        let before = g.ticket();
        g.apply(enabled());
        g.enqueue(before, Event::SessionStarted, "1");
        g.enqueue(before, Event::Failure(Diagnostic::Transcription), "1");
        assert!(g.pending.is_empty());
        g.enqueue(g.ticket(), Event::SessionStarted, "1");
        g.enqueue(g.ticket(), Event::Failure(Diagnostic::Transcription), "1");
        assert_eq!(g.pending.len(), 2);
        assert_eq!(
            g.pending[0].body["distinct_id"],
            g.pending[1].body["distinct_id"]
        );
    }
    #[test]
    fn opt_out_purges_queue_invalidates_tickets_and_rotates_identifiers() {
        let original = enabled();
        let id = original.installation_id.clone();
        let mut g = Gate::new(original);
        let old = g.ticket();
        g.enqueue(old, Event::SessionStarted, "1");
        g.apply(Preferences::default());
        assert!(g.pending.is_empty());
        assert!(g.preferences.installation_id.is_none());
        g.apply(enabled());
        assert_ne!(id, g.preferences.installation_id);
        g.enqueue(old, Event::SessionStarted, "1");
        g.enqueue(old, Event::Failure(Diagnostic::Transcription), "1");
        assert!(g.pending.is_empty());
    }
    #[test]
    fn payloads_are_bounded_and_have_no_content_or_person_profile() {
        let mut g = Gate::new(enabled());
        for _ in 0..100 {
            g.enqueue(g.ticket(), Event::SessionStarted, "1");
        }
        assert_eq!(g.pending.len(), MAX_PENDING);
        let body = Event::Failure(Diagnostic::Transcription).wire("synthetic", "1");
        assert_eq!(body["event"], "$exception");
        assert_eq!(body["properties"]["$process_person_profile"], false);
        assert_eq!(body["properties"]["$geoip_disable"], true);
        assert_eq!(
            body["properties"]["$exception_list"][0]["value"],
            "transcription"
        );
        assert_eq!(body["properties"].as_object().unwrap().len(), 10);
        g.pending.clear();
        for _ in 0..100 {
            g.enqueue(g.ticket(), Event::Failure(Diagnostic::Transcription), "1");
        }
        assert_eq!(g.pending.len(), 20);
    }
    #[test]
    fn configuration_requires_a_project_token_and_explicit_cloud_region() {
        assert!(Config::new("phc_", "https://eu.i.posthog.com").is_none());
        assert!(Config::new("phx_personal", "https://eu.i.posthog.com").is_none());
        assert!(Config::new("phc_example", "").is_none());
        assert!(Config::new("phc_example", "http://eu.i.posthog.com").is_none());
        assert!(Config::new("phc_example", "https://unrelated.example").is_none());
    }

    async fn local_server() -> (
        String,
        tokio::sync::mpsc::Receiver<Value>,
        Arc<Notify>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/i/v0/e/", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let release = Arc::new(Notify::new());
        let permit = release.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                let release = permit.clone();
                connections.spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0; 4096];
                    let (offset, length) = loop {
                        let n = socket.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..n]);
                        assert!(request.len() < 65536);
                        if let Some(offset) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&request[..offset]).to_lowercase();
                            let length = header
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length: "))
                                .unwrap()
                                .parse::<usize>()
                                .unwrap();
                            break (offset + 4, length);
                        }
                    };
                    while request.len() < offset + length {
                        let n = socket.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..n]);
                    }
                    tx.send(serde_json::from_slice(&request[offset..offset + length]).unwrap())
                        .await
                        .unwrap();
                    release.notified().await;
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                        )
                        .await;
                });
            }
        });
        (endpoint, rx, release, server)
    }
    fn local_telemetry(endpoint: String) -> Arc<Telemetry> {
        let (changed, _) = watch::channel(0);
        Arc::new(Telemetry {
            gate: Mutex::new(Gate::new(Preferences::default())),
            writes: Mutex::new(()),
            version: "1.2.3".into(),
            wake: Notify::new(),
            changed,
            config: Some(Config {
                token: "phc_synthetic".into(),
                endpoint,
                client: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap(),
            }),
        })
    }
    #[test]
    fn saved_choices_keep_the_same_id_and_failed_writes_never_enable_or_restore_collection() {
        let t = local_telemetry("http://127.0.0.1:9/unused".into());
        assert!(t.update_consent(true, |_| Err("disk full".into())).is_err());
        assert!(!t.snapshot().enabled && !t.snapshot().decided);
        assert!(t.gate.lock().unwrap().pending.is_empty());
        let mut saved = Value::Null;
        t.update_consent(true, |p| {
            saved = json!(p);
            Ok(())
        })
        .unwrap();
        let original = Preferences::read(Some(saved.clone()));
        let restarted = Gate::new(original.clone());
        assert_eq!(
            restarted.preferences.installation_id,
            original.installation_id
        );
        assert_eq!(restarted.preferences.schema_version, 1);
        let old = t.gate.lock().unwrap().ticket();
        assert!(t
            .update_consent(false, |_| Err("disk full".into()))
            .is_err());
        assert!(!t.snapshot().enabled);
        assert!(t.gate.lock().unwrap().preferences.installation_id.is_none());
        t.capture(old, Event::SessionStarted);
        assert!(t.gate.lock().unwrap().pending.is_empty());
        t.update_consent(false, |p| {
            saved = json!(p);
            Ok(())
        })
        .unwrap();
        let off = Preferences::read(Some(saved));
        assert!(!off.enabled && off.installation_id.is_none());
        assert_eq!(
            off.schema_version, 1,
            "Confirmed off is preserved across upgrades"
        );
        t.update_consent(true, |_| Ok(())).unwrap();
        assert_ne!(
            t.gate.lock().unwrap().preferences.installation_id,
            original.installation_id
        );
    }
    #[tokio::test]
    async fn http_gate_sends_nothing_before_consent_or_after_opt_out_and_cancels_waiting_request() {
        let (endpoint, mut requests, _release, server) = local_server().await;
        let t = local_telemetry(endpoint);
        let worker = tokio::spawn(t.clone().run());
        let before = t.gate.lock().unwrap().ticket();
        t.capture(before, Event::SessionStarted);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), requests.recv())
                .await
                .is_err()
        );
        t.apply(enabled());
        let ticket = t.gate.lock().unwrap().ticket();
        t.capture(before, Event::SessionStarted);
        t.capture(before, Event::Failure(Diagnostic::Transcription));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), requests.recv())
                .await
                .is_err()
        );
        t.capture(ticket, Event::SessionStarted);
        let first = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first["api_key"], "phc_synthetic");
        assert_eq!(first["properties"]["$ip"], "0.0.0.0");
        // The server deliberately holds the first response. A second queued
        // event must be purged and the five-second HTTP wait cancelled.
        t.capture(ticket, Event::OnboardingCompleted);
        t.apply(Preferences::default());
        t.capture(ticket, Event::SessionStarted);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), requests.recv())
                .await
                .is_err()
        );
        t.apply(enabled());
        let new_ticket = t.gate.lock().unwrap().ticket();
        t.capture(ticket, Event::OnboardingCompleted); // Old consent stays invalid.
        t.capture(new_ticket, Event::PageViewed(Page::History));
        let second = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second["event"], "page_viewed");
        assert_ne!(first["distinct_id"], second["distinct_id"]);
        worker.abort();
        server.abort();
    }
    #[tokio::test]
    async fn expired_events_are_dropped_without_stranding_a_fresh_event() {
        let (endpoint, mut requests, _release, server) = local_server().await;
        let t = local_telemetry(endpoint);
        t.apply(enabled());
        let ticket = t.gate.lock().unwrap().ticket();
        t.capture(ticket, Event::SessionStarted);
        t.gate.lock().unwrap().pending.front_mut().unwrap().created =
            Instant::now() - Duration::from_secs(61);
        t.capture(ticket, Event::OnboardingCompleted);
        let worker = tokio::spawn(t.clone().run());
        let received = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received["event"], "onboarding_completed");
        worker.abort();
        server.abort();
    }
}
