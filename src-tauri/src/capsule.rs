use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::cocoa::appkit::{NSApp, NSMainMenuWindowLevel, NSWindowCollectionBehavior};
use tauri_nspanel::cocoa::base::nil;
use tauri_nspanel::cocoa::base::YES;
use tauri_nspanel::cocoa::foundation::{NSPoint, NSRect, NSSize};
use tauri_nspanel::objc::{msg_send, sel, sel_impl};
use tauri_nspanel::{ManagerExt, WebviewWindowExt};
use tauri_plugin_store::StoreExt;

// Panel level above menu bar (Status level = 25)
const PANEL_LEVEL: i32 = NSMainMenuWindowLevel + 2;

// NSWindowStyleMask values as i32
const NS_BORDERLESS_WINDOW_MASK: i32 = 0;
const NS_NONACTIVATING_PANEL_MASK: i32 = 1 << 7;
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 52.0;
const POSITION_STORE: &str = "linty-window-state.json";
static POSITIONED: AtomicBool = AtomicBool::new(false);
// Dictation fallback timers must not hide a newer correction acknowledgment.
static SHOWING_FEEDBACK: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize, Serialize)]
pub struct CorrectionFeedback {
    title: String,
    message: String,
    learned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    actions: Option<Vec<CorrectionFeedbackAction>>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct CorrectionFeedbackAction {
    label: String,
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
}

#[tauri::command]
pub fn show_correction_feedback(
    app: AppHandle,
    feedback: CorrectionFeedback,
) -> Result<(), String> {
    let window = app
        .get_webview_window("capsule")
        .ok_or("Correction panel unavailable")?;
    // The notice is transient: a page that is still reloading has no listener
    // yet. Deliver it once the page has settled instead of losing it.
    if let Some(delay) = app.state::<CapsuleHealth>().reload_settling(Instant::now()) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(window) = app.get_webview_window("capsule") {
                let _ = window.eval("/* wake */");
            }
            if let Err(error) = app.emit_to("capsule", "correction-feedback", feedback) {
                log::warn!("[capsule] Could not deliver a delayed correction notice: {error}");
            }
        });
        return Ok(());
    }
    // Resume a hidden WKWebView before delivering the notice. The webview waits
    // for any active dictation to finish before showing the nonactivating panel.
    window.eval("/* wake */").map_err(|e| e.to_string())?;
    app.emit_to("capsule", "correction-feedback", feedback)
        .map_err(|e| e.to_string())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct CapsulePosition {
    x: f64,
    y: f64,
}

/// Cocoa screen points work across displays with different Retina scales.
/// Keep the complete panel reachable after a display is removed or rearranged.
fn visible_origin(saved: Option<CapsulePosition>, screens: &[NSRect], main: NSRect) -> NSPoint {
    if let Some(position) = saved.filter(|p| p.x.is_finite() && p.y.is_finite()) {
        let center = NSPoint::new(
            position.x + PANEL_WIDTH / 2.0,
            position.y + PANEL_HEIGHT / 2.0,
        );
        if let Some(screen) = screens.iter().find(|screen| {
            center.x >= screen.origin.x
                && center.x <= screen.origin.x + screen.size.width
                && center.y >= screen.origin.y
                && center.y <= screen.origin.y + screen.size.height
        }) {
            return NSPoint::new(
                position.x.clamp(
                    screen.origin.x,
                    screen.origin.x + (screen.size.width - PANEL_WIDTH).max(0.0),
                ),
                position.y.clamp(
                    screen.origin.y,
                    screen.origin.y + (screen.size.height - PANEL_HEIGHT).max(0.0),
                ),
            );
        }
    }
    NSPoint::new(
        main.origin.x + ((main.size.width - PANEL_WIDTH) / 2.0).max(0.0),
        main.origin.y + 32.0_f64.min((main.size.height - PANEL_HEIGHT).max(0.0)),
    )
}

fn saved_position(app: &AppHandle) -> Option<CapsulePosition> {
    app.store(POSITION_STORE)
        .ok()?
        .get("capsulePosition")
        .and_then(|value| serde_json::from_value(value).ok())
}

fn save_position(app: &AppHandle, frame: NSRect) {
    if !POSITIONED.load(Ordering::Relaxed) {
        return;
    }
    let position = CapsulePosition {
        x: frame.origin.x,
        y: frame.origin.y,
    };
    if !position.x.is_finite() || !position.y.is_finite() {
        return;
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let store = app.store(POSITION_STORE)?;
        let value = serde_json::to_value(position)?;
        let previous = store.get("capsulePosition");
        if previous.as_ref() != Some(&value) {
            store.set("capsulePosition", value);
            if let Err(error) = store.save() {
                // Preserve a retry on the next hide if the disk write failed.
                if let Some(previous) = previous {
                    store.set("capsulePosition", previous);
                } else {
                    store.delete("capsulePosition");
                }
                return Err(error.into());
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        log::warn!("[capsule] Could not save panel placement: {error}");
    }
}

// ── Capsule state payload ──

#[derive(Clone, Serialize)]
pub struct CapsuleState {
    pub revision: u64,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hands_free: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Events are transient; a newly loaded capsule must recover the latest state.
#[derive(Default)]
pub struct CapsulePresentation(Mutex<Option<CapsuleState>>);

impl CapsulePresentation {
    fn latest(&self) -> MutexGuard<'_, Option<CapsuleState>> {
        self.0.lock().unwrap_or_else(|error| {
            // This cache contains only presentation data. Retaining its last
            // snapshot after poisoning keeps feedback available without panic.
            log::warn!("[capsule] Recovering presentation cache after a failed update");
            error.into_inner()
        })
    }

    fn update(&self, mut state: CapsuleState) -> CapsuleState {
        let mut latest = self.latest();
        state.revision = latest.as_ref().map_or(1, |previous| previous.revision + 1);
        *latest = Some(state.clone());
        state
    }

    fn clear(&self) {
        self.update(CapsuleState {
            revision: 0,
            state: "idle".into(),
            hands_free: None,
            generation: None,
            error: None,
        });
    }

    fn is_current(&self, revision: u64) -> bool {
        self.latest()
            .as_ref()
            .is_some_and(|latest| latest.revision == revision)
    }
}

#[tauri::command]
pub fn get_capsule_state(app: AppHandle) -> Option<CapsuleState> {
    if SHOWING_FEEDBACK.load(Ordering::SeqCst) {
        return None;
    }
    app.state::<CapsulePresentation>().latest().clone()
}

// ── Lifetime guard (issue #147) ──
// A long-lived capsule page accumulated WebKit heap with every dictation until
// the pill took seconds to paint. The page restores its state from
// CapsulePresentation on load, so reloading it while idle and hidden is
// invisible and bounds memory whatever the cause.

const RELOAD_AFTER_TAKES: u64 = 25;
const RELOAD_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
const RELOAD_ABOVE_BYTES: u64 = 300 * 1024 * 1024;
const RELOAD_MIN_INTERVAL: Duration = Duration::from_secs(30);
const RELOAD_BURST_WINDOW: Duration = Duration::from_secs(5 * 60);
const RELOAD_BURST_LIMIT: usize = 3;
/// A reloaded page needs this long before transient events reach its listeners.
const RELOAD_SETTLE: Duration = Duration::from_secs(2);

pub struct CapsuleHealth {
    takes: AtomicU64,
    last_counted_generation: AtomicU64,
    /// The over-threshold warning was logged; cleared by a relaunch or reload.
    over_threshold_logged: AtomicBool,
    last_reload: Mutex<Instant>,
    reload_started: Mutex<Option<Instant>>,
    recent_reloads: Mutex<Vec<Instant>>,
    throttle_logged: AtomicBool,
}

impl Default for CapsuleHealth {
    fn default() -> Self {
        Self {
            takes: AtomicU64::new(0),
            last_counted_generation: AtomicU64::new(0),
            over_threshold_logged: AtomicBool::new(false),
            last_reload: Mutex::new(Instant::now()),
            reload_started: Mutex::new(None),
            recent_reloads: Mutex::new(Vec::new()),
            throttle_logged: AtomicBool::new(false),
        }
    }
}

/// Other webviews (the main window) reload after a content-process death with
/// the same throttle, so a page that crashes while loading cannot loop.
static OTHER_WEBVIEW_RELOADS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

fn reload_due(takes: u64, age: Duration) -> Option<&'static str> {
    if takes >= RELOAD_AFTER_TAKES {
        Some("takes")
    } else if age >= RELOAD_AFTER {
        Some("age")
    } else {
        None
    }
}

/// A page above the threshold is relaunched (its web process is terminated and
/// WebKit's callback reloads it) once nothing is presented; a reload alone keeps
/// process-level caches. Until then the watchdog keeps checking.
#[derive(Clone, Copy, Debug, PartialEq)]
enum MemoryAction {
    Relaunch,
    Wait,
}
fn memory_action(bytes: u64, idle: bool) -> Option<MemoryAction> {
    if bytes <= RELOAD_ABOVE_BYTES {
        None
    } else if idle {
        Some(MemoryAction::Relaunch)
    } else {
        Some(MemoryAction::Wait)
    }
}

/// One reload per RELOAD_MIN_INTERVAL and RELOAD_BURST_LIMIT per window. A page
/// that terminates or is large right after loading must not reload in a loop.
fn reload_allowed(recent: &[Instant], now: Instant) -> bool {
    let in_window = recent
        .iter()
        .filter(|t| now.duration_since(**t) < RELOAD_BURST_WINDOW)
        .count();
    let since_last = recent.iter().max().map(|t| now.duration_since(*t));
    in_window < RELOAD_BURST_LIMIT && since_last.is_none_or(|gap| gap >= RELOAD_MIN_INTERVAL)
}

impl CapsuleHealth {
    fn note_take(&self, generation: u64) {
        if self
            .last_counted_generation
            .swap(generation, Ordering::SeqCst)
            != generation
        {
            self.takes.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn age(&self, now: Instant) -> Duration {
        now.duration_since(*self.last_reload.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn due(&self, now: Instant) -> Option<&'static str> {
        reload_due(self.takes.load(Ordering::Relaxed), self.age(now))
    }
    /// Reserve a reload slot; false when throttled. Resets the counters.
    fn permit(&self, now: Instant) -> bool {
        let mut recent = self
            .recent_reloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        recent.retain(|t| now.duration_since(*t) < RELOAD_BURST_WINDOW);
        if !reload_allowed(&recent, now) {
            if !self.throttle_logged.swap(true, Ordering::SeqCst) {
                log::error!(
                    "[capsule] Page reload throttled after {} reloads within {} min",
                    recent.len(),
                    RELOAD_BURST_WINDOW.as_secs() / 60
                );
            }
            return false;
        }
        self.throttle_logged.store(false, Ordering::SeqCst);
        recent.push(now);
        *self.last_reload.lock().unwrap_or_else(|e| e.into_inner()) = now;
        *self
            .reload_started
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(now);
        self.takes.store(0, Ordering::Relaxed);
        self.over_threshold_logged.store(false, Ordering::SeqCst);
        true
    }
    /// Time left before a page reloaded at most RELOAD_SETTLE ago can receive
    /// transient events; `None` once it has settled.
    fn reload_settling(&self, now: Instant) -> Option<Duration> {
        let started = (*self
            .reload_started
            .lock()
            .unwrap_or_else(|e| e.into_inner()))?;
        RELOAD_SETTLE
            .checked_sub(now.duration_since(started))
            .filter(|remaining| !remaining.is_zero())
    }
}

pub fn reload_webview_throttled(webview: &tauri::Webview) {
    let now = Instant::now();
    let mut recent = OTHER_WEBVIEW_RELOADS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    recent.retain(|t| now.duration_since(*t) < RELOAD_BURST_WINDOW);
    if !reload_allowed(&recent, now) {
        log::error!(
            "[webview] Reload of '{}' throttled after {} reloads within {} min",
            webview.label(),
            recent.len(),
            RELOAD_BURST_WINDOW.as_secs() / 60
        );
        return;
    }
    recent.push(now);
    if let Err(error) = webview.reload() {
        log::warn!("[webview] Could not reload '{}': {error}", webview.label());
    }
}

/// Nothing is presented and no capture could ask for presentation.
fn capsule_idle(app: &AppHandle) -> bool {
    !SHOWING_FEEDBACK.load(Ordering::SeqCst)
        && app
            .state::<CapsulePresentation>()
            .latest()
            .as_ref()
            .is_none_or(|state| state.state == "idle")
        && !app
            .state::<crate::dictation::Coordinator>()
            .capture_active()
}

/// Reload the capsule page. The page re-reads the presentation snapshot on
/// load, so an idle reload is invisible. A dead process reloads regardless;
/// every other reason re-checks idleness here, as late as possible, because a
/// new take can begin between a caller's check and this call. The residual
/// window (a press within milliseconds of a hide) only delays that pill by the
/// reload time.
pub fn reload_capsule(app: &AppHandle, reason: &str, footprint: Option<u64>) -> bool {
    if reason != "terminated" && !capsule_idle(app) {
        return false;
    }
    let health = app.state::<CapsuleHealth>();
    let now = Instant::now();
    let takes = health.takes.load(Ordering::Relaxed);
    let age_minutes = health.age(now).as_secs() / 60;
    if !health.permit(now) {
        return false;
    }
    let Some(window) = app.get_webview_window("capsule") else {
        return false;
    };
    match window.reload() {
        Ok(()) => {
            log::info!(
                "[capsule] Page reloaded (reason={reason}, takes={takes}, age={age_minutes}min, footprint={})",
                footprint.map_or_else(|| "n/a".to_string(), |bytes| format!("{}MB", bytes >> 20))
            );
            true
        }
        Err(error) => {
            log::warn!("[capsule] Could not reload page: {error}");
            false
        }
    }
}

fn recycle_if_due(app: &AppHandle) {
    let Some(reason) = app.state::<CapsuleHealth>().due(Instant::now()) else {
        return;
    };
    if capsule_idle(app) {
        reload_capsule(app, reason, None);
    }
}

/// Physical footprint of the capsule's web content process, read on the main
/// thread through WebKit's `_webProcessIdentifier`. `Some((0, 0))` when WebKit
/// reports no process; `None` when the value is unavailable.
pub async fn web_process_footprint(app: &AppHandle) -> Option<(i32, u64)> {
    let window = app.get_webview_window("capsule")?;
    let (reply, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let pid = unsafe {
                let view = webview.inner() as tauri_nspanel::cocoa::base::id;
                let responds: bool =
                    msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
                if responds {
                    let pid: i32 = msg_send![view, _webProcessIdentifier];
                    Some(pid)
                } else {
                    None
                }
            };
            let _ = reply.send(pid);
        })
        .ok()?;
    let pid = tokio::time::timeout(Duration::from_secs(2), receive)
        .await
        .ok()?
        .ok()??;
    if pid <= 0 {
        return Some((0, 0));
    }
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let status = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            &mut info as *mut libc::rusage_info_v4 as *mut libc::rusage_info_t,
        )
    };
    (status == 0).then_some((pid, info.ri_phys_footprint))
}

/// Watchdog hook. Bounds the page's memory even if a leak returns: a large page
/// has its web process relaunched as soon as it is idle (process-level caches
/// survive a plain reload); a terminated process reloads at once.
pub async fn check_memory(app: &AppHandle) {
    let Some((pid, bytes)) = web_process_footprint(app).await else {
        return;
    };
    if pid == 0 {
        log::warn!("[capsule] Web content process is gone — reloading page");
        reload_capsule(app, "terminated", None);
        return;
    }
    let health = app.state::<CapsuleHealth>();
    log::debug!(
        "[capsule] Web content footprint {}MB (takes since reload: {})",
        bytes >> 20,
        health.takes.load(Ordering::Relaxed)
    );
    match memory_action(bytes, capsule_idle(app)) {
        None => {}
        Some(MemoryAction::Wait) => {
            if !health.over_threshold_logged.swap(true, Ordering::SeqCst) {
                log::warn!(
                    "[capsule] Web content footprint {}MB exceeds {}MB — relaunch when idle",
                    bytes >> 20,
                    RELOAD_ABOVE_BYTES >> 20
                );
            }
        }
        Some(MemoryAction::Relaunch) => {
            log::warn!(
                "[capsule] Web content footprint {}MB exceeds {}MB — relaunching its web process",
                bytes >> 20,
                RELOAD_ABOVE_BYTES >> 20
            );
            if terminate_web_process(pid) {
                health.over_threshold_logged.store(false, Ordering::SeqCst);
            }
        }
    }
}

/// Terminate the capsule's web content process. WebKit then reports the
/// termination and the page is reloaded (throttled) into a fresh process. The
/// pid was read from WebKit moments ago; its image path is checked again so a
/// recycled pid can never target another program.
fn terminate_web_process(pid: i32) -> bool {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid,
            path.as_mut_ptr() as *mut std::ffi::c_void,
            path.len() as u32,
        )
    };
    let image = if length > 0 {
        String::from_utf8_lossy(&path[..length as usize]).into_owned()
    } else {
        String::new()
    };
    if !image.contains("com.apple.WebKit.WebContent") {
        log::warn!("[capsule] Not terminating pid {pid}: it is no longer a web content process");
        return false;
    }
    if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
        log::warn!("[capsule] Could not terminate web content process {pid}");
        return false;
    }
    true
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;

    #[test]
    fn a_reload_is_due_after_enough_takes_or_age_and_memory_relaunches_when_idle() {
        assert_eq!(reload_due(0, Duration::ZERO), None);
        assert_eq!(
            reload_due(
                RELOAD_AFTER_TAKES - 1,
                RELOAD_AFTER - Duration::from_secs(1)
            ),
            None
        );
        assert_eq!(
            reload_due(RELOAD_AFTER_TAKES, Duration::ZERO),
            Some("takes")
        );
        assert_eq!(reload_due(0, RELOAD_AFTER), Some("age"));
        assert_eq!(memory_action(RELOAD_ABOVE_BYTES, true), None);
        assert_eq!(
            memory_action(RELOAD_ABOVE_BYTES + 1, false),
            Some(MemoryAction::Wait)
        );
        assert_eq!(
            memory_action(RELOAD_ABOVE_BYTES + 1, true),
            Some(MemoryAction::Relaunch)
        );
    }

    #[test]
    fn reloads_are_spaced_out_and_capped_per_window() {
        let start = Instant::now();
        assert!(reload_allowed(&[], start));
        assert!(!reload_allowed(&[start], start + Duration::from_secs(10)));
        assert!(reload_allowed(&[start], start + RELOAD_MIN_INTERVAL));
        let burst: Vec<Instant> = (0..RELOAD_BURST_LIMIT)
            .map(|i| start + RELOAD_MIN_INTERVAL * i as u32)
            .collect();
        let after_burst = *burst.last().unwrap() + RELOAD_MIN_INTERVAL;
        assert!(
            !reload_allowed(&burst, after_burst),
            "A crash loop stops reloading"
        );
        assert!(reload_allowed(
            &burst,
            start + RELOAD_BURST_WINDOW + RELOAD_MIN_INTERVAL * 3
        ));
    }

    #[test]
    fn health_counts_each_capture_once_and_resets_on_reload() {
        let health = CapsuleHealth::default();
        health.note_take(7);
        health.note_take(7);
        health.note_take(8);
        assert_eq!(health.takes.load(Ordering::Relaxed), 2);
        let now = Instant::now();
        assert_eq!(health.due(now), None);
        health.takes.store(RELOAD_AFTER_TAKES, Ordering::Relaxed);
        assert_eq!(health.due(now), Some("takes"));
        health.over_threshold_logged.store(true, Ordering::SeqCst);
        assert!(health.permit(now));
        assert_eq!(health.takes.load(Ordering::Relaxed), 0);
        assert!(!health.over_threshold_logged.load(Ordering::SeqCst));
        assert_eq!(health.due(now), None);
        assert!(
            !health.permit(now + Duration::from_secs(1)),
            "Back-to-back reloads are throttled"
        );
        assert!(
            health
                .reload_settling(now + Duration::from_secs(1))
                .is_some(),
            "Transient notices wait for the reloaded page"
        );
        assert_eq!(health.reload_settling(now + RELOAD_SETTLE), None);
    }
}

// ── Init ──

pub fn init_capsule_panel(app: &AppHandle) {
    let Some(capsule_window) = app.get_webview_window("capsule") else {
        log::warn!("[capsule] No 'capsule' window found — skipping panel init");
        return;
    };

    let panel = capsule_window
        .to_panel()
        .expect("Failed to convert capsule to NSPanel");

    apply_panel_properties(&panel);
    log::info!("[capsule] NSPanel initialized");
}

/// Re-apply all native NSPanel properties. Called on init and after system wake
/// to ensure the panel remains visible above all windows.
pub fn reinit_capsule_properties(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel("capsule") else {
        log::warn!("[capsule] reinit_properties: panel not found — cannot refresh");
        return;
    };
    apply_panel_properties(&panel);
    log::info!("[capsule] NSPanel properties re-applied after wake");
}

fn apply_panel_properties(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    // No delegate — avoids null-pointer crash when windowDidBecomeKey: fires
    // with an unset listener. We don't need delegate callbacks.
    panel.set_level(PANEL_LEVEL);
    panel.set_style_mask(NS_BORDERLESS_WINDOW_MASK | NS_NONACTIVATING_PANEL_MASK);
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
    );
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_opaque(false);
    panel.set_has_shadow(false);
    // The webview decides which regions can drag; buttons keep their actions.
    unsafe {
        let _: () = msg_send![panel, setMovable: YES];
    }
}

// ── Show/Hide ──

#[derive(Debug, Default)]
struct MainWindowPresentation {
    app_active: bool,
    focused: bool,
    visible: bool,
    minimized: bool,
    on_active_space: bool,
}

impl MainWindowPresentation {
    fn active(&self) -> bool {
        self.app_active && self.focused && self.visible && !self.minimized && self.on_active_space
    }
}

// Read one AppKit snapshot on the main thread. A key window belongs to its
// application; that alone does not establish that the application is active.
fn main_window_presentation(app: &AppHandle) -> Result<MainWindowPresentation, String> {
    let Some(main) = app.get_webview_window("main") else {
        return Ok(MainWindowPresentation::default());
    };
    let window = main.ns_window().map_err(|error| error.to_string())?;
    unsafe {
        let window = window as tauri_nspanel::cocoa::base::id;
        let app_active: bool = msg_send![NSApp(), isActive];
        let focused: bool = msg_send![window, isKeyWindow];
        let visible: bool = msg_send![window, isVisible];
        let minimized: bool = msg_send![window, isMiniaturized];
        let on_active_space: bool = msg_send![window, isOnActiveSpace];
        Ok(MainWindowPresentation {
            app_active,
            focused,
            visible,
            minimized,
            on_active_space,
        })
    }
}

#[tauri::command]
pub fn is_dictation_window_active(app: AppHandle) -> Result<bool, String> {
    main_window_presentation(&app).map(|state| state.active())
}

#[tauri::command]
pub fn capsule_state_rendered(app: AppHandle, revision: u64, state: String) {
    let current = app.state::<CapsulePresentation>().latest().clone();
    if current.is_some_and(|current| current.revision == revision && current.state == state) {
        log::info!("[capsule] Rendered state={state} revision={revision}");
    }
}

#[tauri::command]
#[allow(unexpected_cfgs)]
pub fn show_capsule(app: AppHandle, feedback: Option<bool>) -> Result<(), String> {
    if !feedback.unwrap_or(false) {
        match main_window_presentation(&app) {
            Ok(state) if state.active() => {
                log::info!("[capsule] Show skipped: main window owns presentation {state:?}");
                return Ok(());
            }
            Ok(_) => {}
            Err(error) => log::warn!("[capsule] Could not check main window focus: {error}"),
        }
    }
    let panel = app.get_webview_panel("capsule").map_err(|error| {
        log::warn!("[capsule] show_capsule: panel not found: {error:?}");
        "Recording panel unavailable".to_string()
    })?;

    // Re-apply critical properties every show — macOS may reset them after
    // sleep/wake, display reconfiguration, or space changes.
    apply_panel_properties(&panel);

    // Wake the capsule webview's JS context — macOS may suspend WKWebView
    // for hidden windows. Evaluating JS forces the content process to resume
    // before we send state events.
    if let Some(capsule_window) = app.get_webview_window("capsule") {
        if let Err(error) = capsule_window.eval("/* wake */") {
            log::warn!("[capsule] Could not resume panel webview: {error}");
        }
    }

    // Reuse the actual native position after dragging, including between states.
    // First show restores the previous app session; fresh installs start at bottom center.
    unsafe {
        let main_screen = tauri_nspanel::cocoa::appkit::NSScreen::mainScreen(nil);
        if main_screen == nil {
            log::warn!("[capsule] show_capsule: no screen available");
            return Err("No screen available for recording panel".into());
        }
        let visible_frame: NSRect = msg_send![main_screen, visibleFrame];
        let screen_list = tauri_nspanel::cocoa::appkit::NSScreen::screens(nil);
        let count: usize = msg_send![screen_list, count];
        let screens: Vec<NSRect> = (0..count)
            .map(|i| {
                let screen: tauri_nspanel::cocoa::base::id =
                    msg_send![screen_list, objectAtIndex: i];
                msg_send![screen, visibleFrame]
            })
            .collect();
        let saved = if POSITIONED.load(Ordering::Relaxed) {
            let frame: NSRect = msg_send![&*panel, frame];
            Some(CapsulePosition {
                x: frame.origin.x,
                y: frame.origin.y,
            })
        } else {
            saved_position(&app)
        };
        let origin = visible_origin(saved, &screens, visible_frame);
        panel.set_content_size(PANEL_WIDTH, PANEL_HEIGHT);
        let frame = NSRect {
            origin,
            size: NSSize::new(PANEL_WIDTH, PANEL_HEIGHT),
        };
        let _: () = msg_send![&*panel, setFrame: frame display: YES];
        POSITIONED.store(true, Ordering::Relaxed);
    }

    // order_front_regardless avoids making the panel key (no focus steal)
    panel.order_front_regardless();
    let visible: bool = unsafe { msg_send![&*panel, isVisible] };
    log::info!(
        "[capsule] Show requested: panel_visible={visible} feedback={}",
        feedback.unwrap_or(false)
    );
    SHOWING_FEEDBACK.store(feedback.unwrap_or(false), Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn hide_capsule(
    app: AppHandle,
    feedback: Option<bool>,
    revision: Option<u64>,
    for_main_window: Option<bool>,
) {
    if for_main_window.unwrap_or(false) {
        // A delayed focus-change IPC must not hide a pill after the main window
        // was hidden or another app became active. Recheck at execution time.
        match main_window_presentation(&app) {
            Ok(state) if state.active() => {}
            state => {
                log::info!("[capsule] Late main-window hide rejected: {state:?}");
                return;
            }
        }
    }
    if SHOWING_FEEDBACK.load(Ordering::SeqCst) != feedback.unwrap_or(false) {
        return;
    }
    if revision.is_some_and(|revision| !app.state::<CapsulePresentation>().is_current(revision)) {
        return;
    }
    let Ok(panel) = app.get_webview_panel("capsule") else {
        return;
    };
    // Save on hide, not on every mouse move. The panel retains its frame in memory.
    let frame: NSRect = unsafe { msg_send![&*panel, frame] };
    save_position(&app, frame);
    panel.order_out(None);
    log::info!(
        "[capsule] Hidden: revision={revision:?} for_main_window={}",
        for_main_window.unwrap_or(false)
    );
    SHOWING_FEEDBACK.store(false, Ordering::SeqCst);
    if !for_main_window.unwrap_or(false) {
        app.state::<CapsulePresentation>().clear();
        // Hidden and idle: the only moment a page reload is invisible.
        recycle_if_due(&app);
    }
}

#[cfg(test)]
mod placement_tests {
    use super::*;

    fn screen(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }

    #[test]
    fn fresh_and_invalid_positions_use_the_visible_main_screen() {
        let main = screen(0.0, 60.0, 1440.0, 816.0);
        for saved in [
            None,
            Some(CapsulePosition {
                x: f64::NAN,
                y: 100.0,
            }),
            Some(CapsulePosition { x: 9000.0, y: 0.0 }),
        ] {
            let origin = visible_origin(saved, &[main], main);
            assert_eq!((origin.x, origin.y), (530.0, 92.0));
        }
    }

    #[test]
    fn user_placement_survives_on_a_secondary_screen_with_negative_coordinates() {
        let main = screen(0.0, 60.0, 1440.0, 816.0);
        let secondary = screen(-1920.0, -200.0, 1920.0, 1080.0);
        let position = CapsulePosition {
            x: -1100.0,
            y: 150.0,
        };
        let origin = visible_origin(Some(position), &[main, secondary], main);
        assert_eq!((origin.x, origin.y), (position.x, position.y));
        let unplugged = visible_origin(Some(position), &[main], main);
        assert_eq!((unplugged.x, unplugged.y), (530.0, 92.0));
    }

    #[test]
    fn edge_placements_keep_the_entire_panel_in_the_work_area() {
        let main = screen(0.0, 60.0, 1440.0, 816.0);
        let origin = visible_origin(
            Some(CapsulePosition {
                x: 1200.0,
                y: 840.0,
            }),
            &[main],
            main,
        );
        assert_eq!((origin.x, origin.y), (1060.0, 824.0));
        let small = screen(0.0, 0.0, 300.0, 40.0);
        let origin = visible_origin(Some(CapsulePosition { x: 0.0, y: 0.0 }), &[small], small);
        assert_eq!((origin.x, origin.y), (0.0, 0.0));
    }
}

#[cfg(test)]
mod presentation_tests {
    use super::*;

    fn state(mode: &str, generation: u64) -> CapsuleState {
        CapsuleState {
            revision: 0,
            state: mode.into(),
            hands_free: None,
            generation: Some(generation),
            error: None,
        }
    }

    #[test]
    fn snapshot_retains_the_latest_state_and_rejects_an_old_dismissal() {
        let presentation = CapsulePresentation::default();
        assert!(presentation.0.lock().unwrap().is_none());
        let previous = presentation.update(state("done", 1));
        let current = presentation.update(state("recording", 2));
        assert!(!presentation.is_current(previous.revision));
        assert!(presentation.is_current(current.revision));
        let snapshot = presentation.0.lock().unwrap().clone().unwrap();
        assert_eq!(snapshot.state, "recording");
        assert_eq!(snapshot.generation, Some(2));
        assert_eq!(snapshot.revision, current.revision);
    }

    #[test]
    fn hiding_invalidates_the_previous_snapshot_without_reusing_a_revision() {
        let presentation = CapsulePresentation::default();
        let recording = presentation.update(state("recording", 1));
        presentation.clear();
        assert!(!presentation.is_current(recording.revision));
        assert_eq!(
            presentation.0.lock().unwrap().as_ref().unwrap().state,
            "idle"
        );
        let next = presentation.update(state("recording", 2));
        assert!(next.revision > recording.revision + 1);
    }

    #[test]
    fn main_window_owns_feedback_only_when_it_is_actually_active_and_visible() {
        let mut state = MainWindowPresentation {
            app_active: true,
            focused: true,
            visible: true,
            minimized: false,
            on_active_space: true,
        };
        assert!(state.active());
        state.visible = false;
        assert!(
            !state.active(),
            "A hide queued before closing cannot hide the recording pill"
        );
        state.visible = true;
        state.app_active = false;
        assert!(
            !state.active(),
            "A key window in an inactive app cannot suppress the pill"
        );
        state.app_active = true;
        state.on_active_space = false;
        assert!(
            !state.active(),
            "A window on another Space cannot own visible feedback"
        );
        state.on_active_space = true;
        state.minimized = true;
        assert!(!state.active());
    }
}

// ── Emit state ──

#[tauri::command]
pub fn emit_capsule_state(
    app: AppHandle,
    state: String,
    hands_free: Option<bool>,
    generation: Option<u64>,
    error: Option<String>,
) {
    if generation.is_some_and(|g| !app.state::<crate::dictation::Coordinator>().is_current(g)) {
        return;
    }
    if state == "idle" && SHOWING_FEEDBACK.load(Ordering::SeqCst) {
        return;
    }
    SHOWING_FEEDBACK.store(false, Ordering::SeqCst);
    let payload = app.state::<CapsulePresentation>().update(CapsuleState {
        revision: 0,
        state,
        hands_free,
        generation,
        error,
    });
    log::info!(
        "[capsule] State={} revision={} generation={:?}",
        payload.state,
        payload.revision,
        payload.generation
    );
    if payload.state == "recording" {
        if let Some(generation) = payload.generation {
            app.state::<CapsuleHealth>().note_take(generation);
        }
    }
    if payload.state != "idle" {
        let handle = app.clone();
        let revision = payload.revision;
        // A state transition also restores native visibility. This does not
        // depend on a separate frontend show IPC winning a focus/hide race.
        let scheduled = app.run_on_main_thread(move || {
            if handle.state::<CapsulePresentation>().is_current(revision) {
                let _ = show_capsule(handle, None);
            }
        });
        if let Err(error) = scheduled {
            log::warn!("[capsule] Could not schedule panel visibility: {error}");
        }
    }
    if let Err(error) = app.emit_to("capsule", "capsule-state", &payload) {
        log::warn!("[capsule] Could not deliver panel state: {error}");
    }
    // Resume a suspended WKWebView with the state itself. A no-op wake followed
    // by a transient event cannot guarantee that its listener was ready.
    if let Some(window) = app.get_webview_window("capsule") {
        match serde_json::to_string(&payload) {
            Ok(payload) => {
                let script = format!(
                    "window.dispatchEvent(new CustomEvent('capsule-state-replay', {{ detail: {payload} }}));"
                );
                if let Err(error) = window.eval(script) {
                    log::warn!("[capsule] Could not resume panel state: {error}");
                }
            }
            Err(error) => log::warn!("[capsule] Could not serialize panel state: {error}"),
        }
    }
}

// ── Sound effects ──

#[tauri::command]
pub fn play_capsule_sound(sound: String) {
    let (path, volume) = match sound.as_str() {
        "start" => ("/System/Library/Sounds/Tink.aiff", "0.15"),
        "processing" => ("/System/Library/Sounds/Pop.aiff", "0.12"),
        "success" => ("/System/Library/Sounds/Tink.aiff", "0.2"),
        "error" => ("/System/Library/Sounds/Basso.aiff", "0.2"),
        _ => return,
    };

    std::thread::spawn(move || {
        let _ = std::process::Command::new("afplay")
            .args(["-v", volume, path])
            .output();
    });
}
