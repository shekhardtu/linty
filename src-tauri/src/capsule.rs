use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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

#[path = "capsule_recovery.rs"]
mod recovery;
use recovery::{RendererAction, RendererRecovery, SpaceRecovery};

// Panel level above menu bar (Status level = 25)
const PANEL_LEVEL: i32 = NSMainMenuWindowLevel + 2;
// AppKit NSWindow.h: NSWindowAnimationBehaviorNone = 2 (NSInteger, macOS 10.7+).
pub(crate) const NS_WINDOW_ANIMATION_BEHAVIOR_NONE: isize = 2;

// NSWindowStyleMask values as i32
const NS_BORDERLESS_WINDOW_MASK: i32 = 0;
const NS_NONACTIVATING_PANEL_MASK: i32 = 1 << 7;
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 52.0;
const POSITION_STORE: &str = "linty-window-state.json";
static POSITIONED: AtomicBool = AtomicBool::new(false);
// Preserve the actual runtime class (including any KVO subclass). WebKit's
// window observers and Tao's teardown need it restored before destruction.
static ORIGINAL_PANEL_CLASS: AtomicUsize = AtomicUsize::new(0);
// If teardown times out, the old registry entry is an NSWindow again, not an
// NSPanel. Keep NSPanel-only messages deferred until a replacement is ready.
static PANEL_DETACHED: AtomicBool = AtomicBool::new(false);
// Dictation fallback timers must not hide a newer correction acknowledgment.
static SHOWING_FEEDBACK: AtomicBool = AtomicBool::new(false);

#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
static SIMULATED_OFF_SPACE_WINDOW: AtomicU64 = AtomicU64::new(0);
#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
static REHEARSAL_RENDERED_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
static REHEARSAL_NAVIGATION_RETRIES: AtomicU64 = AtomicU64::new(0);

#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
#[allow(dead_code)]
pub fn rehearsal_navigation_retries() -> u64 {
    REHEARSAL_NAVIGATION_RETRIES.load(Ordering::SeqCst)
}

#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
#[allow(dead_code)]
pub fn rehearsal_rendered_generation() -> u64 {
    REHEARSAL_RENDERED_GENERATION.load(Ordering::SeqCst)
}

fn panel_on_active_space(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) -> bool {
    #[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
    {
        let number: u64 = unsafe { msg_send![panel, windowNumber] };
        if SIMULATED_OFF_SPACE_WINDOW.load(Ordering::SeqCst) == number {
            return false;
        }
    }
    unsafe { msg_send![panel, isOnActiveSpace] }
}

/// Deterministic simulation of the observed boundary failure: AppKit considers
/// the original panel visible, while the user sees nothing and Space recovery
/// checks fail. Only that window is affected; the replacement is measured
/// normally. No IPC command exposes this opt-in development hook.
#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
#[allow(dead_code)]
pub fn simulate_failed_panel(app: &AppHandle) {
    let panel = app.get_webview_panel("capsule").expect("Rehearsal panel");
    let number: u64 = unsafe { msg_send![&*panel, windowNumber] };
    SIMULATED_OFF_SPACE_WINDOW.store(number, Ordering::SeqCst);
    panel.set_alpha_value(0.0);
}

/// Exercise the real hide command after a simulated teardown timeout, without
/// destroying a second native window. The old revision must remain rejected.
#[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
#[allow(dead_code)]
pub fn rehearse_detached_dismissal(app: &AppHandle) -> Result<(), String> {
    let health = app.state::<CapsuleHealth>();
    let now = Instant::now();
    {
        let mut recovery = health.space_recovery();
        let epoch = recovery.begin_probe().ok_or("Probe unavailable")?;
        recovery.finish(epoch, false);
        if !recovery.begin_rebuild(true, now) {
            return Err("Initial simulated rebuild unavailable".into());
        }
        recovery.rebuilt(false);
    }
    PANEL_DETACHED.store(true, Ordering::SeqCst);
    let terminal = app.state::<CapsulePresentation>().update(CapsuleState {
        revision: 0,
        state: "done".into(),
        hands_free: None,
        generation: Some(499),
        error: None,
    });
    hide_capsule(app.clone(), None, Some(terminal.revision - 1), None);
    let stale_rejected = app
        .state::<CapsulePresentation>()
        .is_current(terminal.revision);
    hide_capsule(app.clone(), None, Some(terminal.revision), None);
    let retry = health
        .space_recovery()
        .begin_rebuild(capsule_idle(app), now + Duration::from_secs(31));
    PANEL_DETACHED.store(false, Ordering::SeqCst);
    *health.space_recovery() = SpaceRecovery::default();
    if !stale_rejected || !retry {
        return Err("Terminal dismissal after timeout did not permit a safe retry".into());
    }
    Ok(())
}

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
    // The notice is transient: a page that is still reloading has no listener
    // yet. Deliver it once the page has settled instead of losing it.
    let health = app.state::<CapsuleHealth>();
    let delay = if panel_replacing(&app) {
        Some(Duration::from_millis(200))
    } else {
        health.reload_settling(Instant::now())
    };
    if let Some(delay) = delay {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Err(error) = show_correction_feedback(app, feedback) {
                log::warn!("[capsule] Could not deliver a delayed correction notice: {error}");
            }
        });
        return Ok(());
    }
    let window = app
        .get_webview_window("capsule")
        .ok_or("Correction panel unavailable")?;
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

fn overlap(a: NSRect, b: NSRect) -> f64 {
    let width =
        (a.origin.x + a.size.width).min(b.origin.x + b.size.width) - a.origin.x.max(b.origin.x);
    let height =
        (a.origin.y + a.size.height).min(b.origin.y + b.size.height) - a.origin.y.max(b.origin.y);
    width.max(0.0) * height.max(0.0)
}

/// The display showing most of `rect`.
fn screen_for_rect(rect: NSRect, screens: &[NSRect]) -> Option<usize> {
    screens
        .iter()
        .enumerate()
        .map(|(index, screen)| (index, overlap(rect, *screen)))
        .filter(|(_, area)| *area > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(index, _)| index)
}

fn screen_for_point(point: NSPoint, screens: &[NSRect]) -> Option<usize> {
    screens.iter().position(|screen| {
        point.x >= screen.origin.x
            && point.x < screen.origin.x + screen.size.width
            && point.y >= screen.origin.y
            && point.y < screen.origin.y + screen.size.height
    })
}

/// The same place on another display: the horizontal centre as a fraction of
/// the width, and the distance to the nearer of the top and bottom edges.
fn origin_on_screen(origin: NSPoint, from: NSRect, to: NSRect) -> NSPoint {
    let centre =
        ((origin.x + PANEL_WIDTH / 2.0 - from.origin.x) / from.size.width.max(1.0)).clamp(0.0, 1.0);
    let x = to.origin.x + centre * to.size.width - PANEL_WIDTH / 2.0;
    let below = origin.y - from.origin.y;
    let above = from.origin.y + from.size.height - (origin.y + PANEL_HEIGHT);
    let y = if below <= above {
        to.origin.y + below.max(0.0)
    } else {
        to.origin.y + to.size.height - PANEL_HEIGHT - above.max(0.0)
    };
    NSPoint::new(
        x.clamp(
            to.origin.x,
            to.origin.x + (to.size.width - PANEL_WIDTH).max(0.0),
        ),
        y.clamp(
            to.origin.y,
            to.origin.y + (to.size.height - PANEL_HEIGHT).max(0.0),
        ),
    )
}

/// The display of the window the user is working in: the frontmost
/// application's topmost window (WindowServer's list, no Accessibility round
/// trip to another app on the main thread), else the display under the pointer.
/// `frames` are full display frames in Cocoa coordinates, the primary first.
#[allow(unexpected_cfgs)]
fn focused_screen(frames: &[NSRect]) -> Option<usize> {
    focused_window_frame(frames)
        .and_then(|window| screen_for_rect(window, frames))
        .or_else(|| {
            let pointer: NSPoint =
                unsafe { msg_send![tauri_nspanel::objc::class!(NSEvent), mouseLocation] };
            screen_for_point(pointer, frames)
        })
}

#[allow(unexpected_cfgs)]
fn focused_window_frame(frames: &[NSRect]) -> Option<NSRect> {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct CGRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
        fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
        static kCGWindowOwnerPID: *const c_void;
        static kCGWindowLayer: *const c_void;
        static kCGWindowBounds: *const c_void;
    }
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, kind: i64, out: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    const SINT32: i64 = 3;

    let primary = frames.first()?;
    let pid: i32 = unsafe {
        let workspace: tauri_nspanel::cocoa::base::id =
            msg_send![tauri_nspanel::objc::class!(NSWorkspace), sharedWorkspace];
        let front: tauri_nspanel::cocoa::base::id = msg_send![workspace, frontmostApplication];
        if front == nil {
            return None;
        }
        msg_send![front, processIdentifier]
    };
    unsafe {
        let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if list.is_null() {
            return None;
        }
        let number = |dict: *const c_void, key: *const c_void| -> Option<i32> {
            let value = CFDictionaryGetValue(dict, key);
            let mut out = 0i32;
            (!value.is_null() && CFNumberGetValue(value, SINT32, &mut out as *mut _ as *mut c_void))
                .then_some(out)
        };
        // Front to back: the first sizeable normal-level window is the one in use.
        let found = (0..CFArrayGetCount(list)).find_map(|index| {
            let window = CFArrayGetValueAtIndex(list, index);
            if number(window, kCGWindowOwnerPID) != Some(pid)
                || number(window, kCGWindowLayer) != Some(0)
            {
                return None;
            }
            let mut bounds = CGRect::default();
            let bounds_dict = CFDictionaryGetValue(window, kCGWindowBounds);
            if bounds_dict.is_null()
                || !CGRectMakeWithDictionaryRepresentation(bounds_dict, &mut bounds)
                || bounds.width < 100.0
                || bounds.height < 100.0
            {
                return None;
            }
            // WindowServer measures from the primary display's top-left corner.
            Some(NSRect::new(
                NSPoint::new(
                    bounds.x,
                    primary.origin.y + primary.size.height - bounds.y - bounds.height,
                ),
                NSSize::new(bounds.width, bounds.height),
            ))
        });
        CFRelease(list);
        found
    }
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
pub fn get_capsule_state(app: AppHandle, window: tauri::WebviewWindow) -> Option<CapsuleState> {
    let snapshot = app.state::<CapsulePresentation>().latest().clone();
    // An idle page has no rendered-state ACK. Reading its snapshot proves the
    // new page reached its listener setup; active presentations require render.
    if snapshot.as_ref().is_none_or(|state| state.state == "idle") {
        acknowledge_replacement_renderer(&app, &window);
    }
    if SHOWING_FEEDBACK.load(Ordering::SeqCst) {
        return None;
    }
    snapshot
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
    space_recovery: Mutex<SpaceRecovery>,
    renderer_recovery: Mutex<RendererRecovery>,
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
            space_recovery: Mutex::new(SpaceRecovery::default()),
            renderer_recovery: Mutex::new(RendererRecovery::default()),
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
    fn space_recovery(&self) -> MutexGuard<'_, SpaceRecovery> {
        self.space_recovery
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

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
    /// Whether a reload would be permitted right now. A web process is only
    /// terminated when the reload that brings it back will not be throttled.
    fn relaunch_allowed(&self, now: Instant) -> bool {
        let recent = self
            .recent_reloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let recent: Vec<Instant> = recent
            .iter()
            .copied()
            .filter(|t| now.duration_since(*t) < RELOAD_BURST_WINDOW)
            .collect();
        reload_allowed(&recent, now)
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

fn panel_replacing(app: &AppHandle) -> bool {
    PANEL_DETACHED.load(Ordering::SeqCst)
        || app.state::<CapsuleHealth>().space_recovery().rebuilding()
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
    if panel_replacing(app) {
        return false;
    }
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
            // The termination callback reloads through the throttle. Never
            // kill a process whose reload would be refused: a blank panel is
            // worse than a large one.
            if !health.relaunch_allowed(Instant::now()) {
                if !health.over_threshold_logged.swap(true, Ordering::SeqCst) {
                    log::warn!(
                        "[capsule] Web content footprint {}MB exceeds {}MB — relaunch waits for the reload throttle",
                        bytes >> 20,
                        RELOAD_ABOVE_BYTES >> 20
                    );
                }
                return;
            }
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
        assert!(
            !health.relaunch_allowed(now + Duration::from_secs(1)),
            "A web process is not killed while its reload would be throttled"
        );
        assert!(health.relaunch_allowed(now + RELOAD_MIN_INTERVAL));
    }
}

// ── Init ──

pub fn init_capsule_panel(app: &AppHandle) {
    let Some(capsule_window) = app.get_webview_window("capsule") else {
        log::warn!("[capsule] No 'capsule' window found — skipping panel init");
        return;
    };

    let panel = owned_capsule_panel(&capsule_window).expect("Failed to convert capsule to NSPanel");

    apply_panel_properties(&panel);
    log::info!("[capsule] NSPanel initialized");
}

fn owned_capsule_panel(window: &tauri::WebviewWindow) -> tauri::Result<tauri_nspanel::Panel> {
    // tauri-nspanel adopts ns_window with Id::from_retained_ptr without
    // retaining it. Tao also owns that window. Give the plugin its own +1 so
    // destroying Tao's window cannot leave its registry with a dangling panel;
    // replacing the registry entry releases this reference.
    let native = window.ns_window()? as tauri_nspanel::cocoa::base::id;
    unsafe {
        ORIGINAL_PANEL_CLASS.store(
            tauri_nspanel::objc::runtime::object_getClass(native) as usize,
            Ordering::SeqCst,
        );
        let _: tauri_nspanel::cocoa::base::id = msg_send![native, retain];
    }
    match window.to_panel() {
        Ok(panel) => {
            PANEL_DETACHED.store(false, Ordering::SeqCst);
            Ok(panel)
        }
        Err(error) => {
            unsafe {
                let _: () = msg_send![native, release];
            }
            Err(error)
        }
    }
}

/// Re-apply all native NSPanel properties. Called on init and after system wake
/// to ensure the panel remains visible above all windows.
pub fn reinit_capsule_properties(app: &AppHandle) {
    if panel_replacing(app) {
        return;
    }
    let Ok(panel) = app.get_webview_panel("capsule") else {
        log::warn!("[capsule] reinit_properties: panel not found — cannot refresh");
        return;
    };
    apply_panel_properties(&panel);
    // AppKit ignores an unchanged collection behaviour, so only a change makes
    // WindowServer recompute the panel's Space membership.
    panel.set_collection_behaviour(NSWindowCollectionBehavior::NSWindowCollectionBehaviorDefault);
    panel.set_collection_behaviour(panel_collection_behaviour());
    log::info!("[capsule] NSPanel properties re-applied after wake");
}

fn panel_collection_behaviour() -> NSWindowCollectionBehavior {
    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle
}

/// WindowServer can drop the panel's all-Spaces membership and pin it to the
/// Space it was last on (seen after ~18 h with sleep/wake and full-screen
/// Spaces): AppKit then reports it visible while it is on no Space the user can
/// see. Re-setting the same collection behaviour is a no-op in AppKit, so the
/// panel is moved to the active Space and the behaviour is set again, which
/// makes WindowServer recompute its membership.
fn rejoin_active_space(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
    );
    panel.order_front_regardless();
    panel.set_collection_behaviour(panel_collection_behaviour());
}

fn apply_panel_properties(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    // No delegate — avoids null-pointer crash when windowDidBecomeKey: fires
    // with an unset listener. We don't need delegate callbacks.
    panel.set_style_mask(NS_BORDERLESS_WINDOW_MASK | NS_NONACTIVATING_PANEL_MASK);
    panel.set_collection_behaviour(panel_collection_behaviour());
    // setFloatingPanel: resets the level to NSFloatingWindowLevel, so the level
    // is set after it.
    panel.set_floating_panel(true);
    panel.set_level(PANEL_LEVEL);
    panel.set_hides_on_deactivate(false);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_opaque(false);
    panel.set_has_shadow(false);
    // The webview decides which regions can drag; buttons keep their actions.
    unsafe {
        // The renderer owns the pill's fades, including reduced motion.
        // Rapid native order-in/out accumulated 65 blocked NSAnimation workers
        // in the stress trace, exhausting dispatch workers and starving WebKit.
        // Suppress that duplicate animation; keep the renderer's own fades.
        let _: () = msg_send![panel, setAnimationBehavior: NS_WINDOW_ANIMATION_BEHAVIOR_NONE];
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
pub fn capsule_state_rendered(
    app: AppHandle,
    window: tauri::WebviewWindow,
    revision: u64,
    state: String,
) {
    let current = app.state::<CapsulePresentation>().latest().clone();
    if current
        .as_ref()
        .is_some_and(|current| current.revision == revision && current.state == state)
    {
        if !current_capsule_window(&app, &window) {
            return;
        }
        acknowledge_replacement_renderer(&app, &window);
        log::info!("[capsule] Rendered state={state} revision={revision}");
        #[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
        REHEARSAL_RENDERED_GENERATION.store(
            current.and_then(|current| current.generation).unwrap_or(0),
            Ordering::SeqCst,
        );
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
    // A capture can start between destroying the idle window and creating its
    // replacement. Its presentation stays in Rust and the new page restores
    // that snapshot; never call AppKit on the plugin's old panel during this gap.
    if panel_replacing(&app) {
        return Ok(());
    }
    let panel = app.get_webview_panel("capsule").map_err(|error| {
        log::warn!("[capsule] show_capsule: panel not found: {error:?}");
        "Recording panel unavailable".to_string()
    })?;

    let was_visible: bool = unsafe { msg_send![&*panel, isVisible] };

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
        let (frames, screens): (Vec<NSRect>, Vec<NSRect>) = (0..count)
            .map(|i| {
                let screen: tauri_nspanel::cocoa::base::id =
                    msg_send![screen_list, objectAtIndex: i];
                let frame: NSRect = msg_send![screen, frame];
                let visible: NSRect = msg_send![screen, visibleFrame];
                (frame, visible)
            })
            .unzip();
        let saved = if POSITIONED.load(Ordering::Relaxed) {
            let frame: NSRect = msg_send![&*panel, frame];
            Some(CapsulePosition {
                x: frame.origin.x,
                y: frame.origin.y,
            })
        } else {
            saved_position(&app)
        };
        // A hidden pill opens on the display the user is working on, at its
        // usual place there; a showing pill stays put for the rest of the take.
        let focus = if was_visible {
            None
        } else {
            focused_screen(&frames)
        };
        let main = focus.map_or(visible_frame, |index| screens[index]);
        let mut origin = visible_origin(saved, &screens, main);
        if let Some(target) = focus {
            let rect = NSRect::new(origin, NSSize::new(PANEL_WIDTH, PANEL_HEIGHT));
            if let Some(from) = screen_for_rect(rect, &screens).filter(|from| *from != target) {
                origin = origin_on_screen(origin, screens[from], screens[target]);
            }
        }
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
    let on_active_space = ensure_on_active_space(&app, &panel, "show");
    log::info!(
        "[capsule] Show requested: panel_visible={visible} on_active_space={on_active_space} feedback={}",
        feedback.unwrap_or(false)
    );
    SHOWING_FEEDBACK.store(feedback.unwrap_or(false), Ordering::SeqCst);
    Ok(())
}

/// Returns whether the panel was on the active Space; rejoins it when a visible
/// panel was not.
fn ensure_on_active_space(
    app: &AppHandle,
    panel: &tauri_nspanel::raw_nspanel::RawNSPanel,
    trigger: &str,
) -> bool {
    let visible: bool = unsafe { msg_send![panel, isVisible] };
    let on_active_space = panel_on_active_space(panel);
    if visible && !on_active_space {
        let epoch = app.state::<CapsuleHealth>().space_recovery().begin_probe();
        if let Some(epoch) = epoch {
            rejoin_active_space(panel);
            log::warn!(
                "[capsule] Panel was off the active Space on {trigger} — trying Space rejoin"
            );
            confirm_on_active_space(app.clone(), epoch, false);
        }
    }
    on_active_space
}

/// A visible pill follows the user to a Space they switch to mid-dictation,
/// including full-screen Spaces created after launch, which an all-Spaces
/// window does not always join.
pub fn register_space_observer(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ptr::NonNull;

    let handle = app.clone();
    let block = RcBlock::new(move |_notification: NonNull<AnyObject>| {
        if let Ok(panel) = handle.get_webview_panel("capsule") {
            ensure_on_active_space(&handle, &panel, "space change");
        }
    });
    let (Some(workspace_class), Some(string_class), Some(queue_class)) = (
        AnyClass::get(c"NSWorkspace"),
        AnyClass::get(c"NSString"),
        AnyClass::get(c"NSOperationQueue"),
    ) else {
        log::warn!("[capsule] AppKit classes unavailable — Space observer not registered");
        return;
    };
    unsafe {
        let workspace: *mut AnyObject = objc2::msg_send![workspace_class, sharedWorkspace];
        let center: *mut AnyObject = objc2::msg_send![workspace, notificationCenter];
        let name: *mut AnyObject = objc2::msg_send![
            string_class,
            stringWithUTF8String: c"NSWorkspaceActiveSpaceDidChangeNotification".as_ptr()
        ];
        // The main queue keeps the AppKit calls on the main thread.
        let queue: *mut AnyObject = objc2::msg_send![queue_class, mainQueue];
        let _observer: *mut AnyObject = objc2::msg_send![
            center,
            addObserverForName: name,
            object: std::ptr::null_mut::<AnyObject>(),
            queue: queue,
            usingBlock: &*block
        ];
    }
    // The observer lives for the whole process.
    std::mem::forget(block);
    log::debug!("[capsule] Registered active Space observer");
}

// WindowServer applies the new Space membership after the current run-loop
// pass, so the outcome is read a moment later.
fn confirm_on_active_space(app: AppHandle, epoch: u64, reshown: bool) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let health = handle.state::<CapsuleHealth>();
            if !health.space_recovery().current(epoch) {
                return;
            }
            let Ok(panel) = handle.get_webview_panel("capsule") else {
                health.space_recovery().finish(epoch, false);
                return;
            };
            let visible: bool = unsafe { msg_send![&*panel, isVisible] };
            let on_active_space = panel_on_active_space(&panel);
            if !visible {
                health.space_recovery().cancel_probe();
            } else if on_active_space {
                health.space_recovery().finish(epoch, true);
                log::info!(
                    "[capsule] Space recovery confirmed: panel_visible=true on_active_space=true"
                );
            } else if !reshown {
                // Ordering a window that AppKit already considers visible can
                // leave its stale Space association unchanged. Hide first so
                // the next order-in performs a real presentation transition.
                panel.order_out(None);
                rejoin_active_space(&panel);
                log::warn!("[capsule] Space rejoin failed — trying one hide/show");
                confirm_on_active_space(handle.clone(), epoch, true);
            } else {
                health.space_recovery().finish(epoch, false);
                log::error!("[capsule] Space recovery failed — panel rebuild queued until idle");
            }
        });
    });
}

/// Retry a queued repair from the watchdog as well as the hide path: a rebuild
/// refused by the throttle must not wait forever for another dictation.
pub fn rebuild_panel_if_needed(app: &AppHandle) {
    let health = app.state::<CapsuleHealth>();
    let hidden = app
        .get_webview_panel("capsule")
        .map_or(true, |panel| !panel.is_visible());
    let idle = hidden && capsule_idle(app);
    if !health.space_recovery().begin_rebuild(idle, Instant::now()) {
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "capsule")
        .cloned()
    else {
        health.space_recovery().rebuilt(false);
        log::error!("[capsule] Cannot rebuild panel: capsule configuration missing");
        return;
    };
    if let Some(window) = app.get_webview_window("capsule") {
        // to_panel changes the Objective-C class in place. Closing that object
        // as RawNSPanel makes WebKit remove KVO observers from the wrong class
        // (native rehearsal: contentLayoutRect observer exception). Restore
        // the exact original class before handing teardown back to Tao.
        let original = ORIGINAL_PANEL_CLASS.load(Ordering::SeqCst);
        let Ok(native) = window.ns_window() else {
            health.space_recovery().rebuilt(false);
            log::error!("[capsule] Cannot rebuild panel: native window unavailable");
            return;
        };
        if original == 0 {
            health.space_recovery().rebuilt(false);
            log::error!("[capsule] Cannot rebuild panel: original native class unavailable");
            return;
        }
        let native = native as tauri_nspanel::cocoa::base::id;
        PANEL_DETACHED.store(true, Ordering::SeqCst);
        let panel_class = unsafe {
            tauri_nspanel::raw_nspanel::object_setClass(
                native,
                original as tauri_nspanel::cocoa::base::id,
            )
        };
        if let Err(error) = window.destroy() {
            unsafe {
                tauri_nspanel::raw_nspanel::object_setClass(native, panel_class);
            }
            PANEL_DETACHED.store(false, Ordering::SeqCst);
            health.space_recovery().rebuilt(false);
            log::error!("[capsule] Cannot destroy failed panel: {error}");
            return;
        }
    }
    log::warn!("[capsule] Rebuilding idle panel after failed Space recovery");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Tauri removes the old label when the native Destroyed event arrives.
        // Creating the replacement before that event would duplicate the label.
        for attempt in 0..20 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let handle = handle.clone();
            let config = config.clone();
            let (reply, receive) = tokio::sync::oneshot::channel();
            let dispatch = app_dispatch_rebuild(&handle, config, attempt == 19, reply);
            if dispatch.is_err() {
                handle
                    .state::<CapsuleHealth>()
                    .space_recovery()
                    .rebuilt(false);
                return;
            }
            match receive.await {
                Ok(true) => return,
                Ok(false) => {}
                Err(_) => return,
            }
        }
    });
}

fn current_capsule_window(app: &AppHandle, caller: &tauri::WebviewWindow) -> bool {
    caller.label() == "capsule"
        && app
            .get_webview_window("capsule")
            .and_then(|current| current.ns_window().ok())
            .zip(caller.ns_window().ok())
            .is_some_and(|(current, caller)| current == caller)
}

fn acknowledge_replacement_renderer(app: &AppHandle, caller: &tauri::WebviewWindow) {
    if !current_capsule_window(app, caller) {
        return;
    }
    let Ok(native) = caller.ns_window() else {
        return;
    };
    if app
        .state::<CapsuleHealth>()
        .renderer_recovery
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .acknowledge(native as usize)
    {
        log::info!("[capsule] Replacement renderer readiness confirmed");
    }
}

fn monitor_replacement_renderer(app: AppHandle, epoch: u64, native: usize) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..2 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let handle = app.clone();
            let (done, completed) = tokio::sync::oneshot::channel();
            if app.run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window("capsule") else { return; };
                if window.ns_window().ok().map(|p| p as usize) != Some(native) { return; }
                let action = handle.state::<CapsuleHealth>().renderer_recovery.lock().unwrap_or_else(|e| e.into_inner()).timeout(epoch, native);
                match action {
                    RendererAction::Ignore => {}
                    RendererAction::Retry => {
                        #[cfg(all(debug_assertions, feature = "capsule-recovery-test"))]
                        REHEARSAL_NAVIGATION_RETRIES.fetch_add(1, Ordering::SeqCst);
                        log::warn!("[capsule] Replacement renderer unconfirmed — retrying initial navigation once");
                        // This bounded fresh-window retry is separate from idle
                        // page recycling; it never changes that global throttle.
                        // WKWebView.URL can be nil before the first commit;
                        // Wry's URL getter unwraps it. Native reload is safe in
                        // that state; an unconfirmed reload still follows the
                        // bounded failure path and queues an idle replacement.
                        if let Err(error) = window.reload() {
                            log::error!("[capsule] Replacement navigation retry failed: {error}");
                        }
                    }
                    RendererAction::Failed => {
                        log::error!("[capsule] Replacement renderer still unconfirmed — rebuild queued until idle within existing limits");
                        handle.state::<CapsuleHealth>().space_recovery().rebuilt(false);
                        rebuild_panel_if_needed(&handle);
                    }
                }
                let _ = done.send(action);
            }).is_err() { return; }
            // Do not queue a second timer behind a hung main thread and then
            // fail immediately when both callbacks run during recovery. Await
            // the one queued callback even through a hang: its retry must arm
            // the second observation once the main thread recovers.
            if !matches!(completed.await, Ok(RendererAction::Retry)) {
                return;
            }
        }
    });
}

fn app_dispatch_rebuild(
    app: &AppHandle,
    config: tauri::utils::config::WindowConfig,
    last_attempt: bool,
    reply: tokio::sync::oneshot::Sender<bool>,
) -> tauri::Result<()> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let health = handle.state::<CapsuleHealth>();
        if handle.get_webview_window("capsule").is_some() {
            if last_attempt {
                health.space_recovery().rebuilt(false);
                log::error!("[capsule] Panel rebuild timed out waiting for window destruction");
            }
            let _ = reply.send(last_attempt);
            return;
        }
        let rebuilt = tauri::WebviewWindowBuilder::from_config(&handle, &config)
            .and_then(|builder| builder.visible(false).focused(false).build())
            .and_then(|window| {
                let panel = owned_capsule_panel(&window)?;
                apply_panel_properties(&panel);
                Ok(window)
            });
        match rebuilt {
            Ok(window) => {
                POSITIONED.store(false, Ordering::Relaxed);
                *health
                    .reload_started
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                // Release only the native replacement guard: frame/render IPC
                // must run while renderer readiness is still unconfirmed.
                health.space_recovery().rebuilt(true);
                if let Ok(native) = window.ns_window() {
                    let native = native as usize;
                    let epoch = health
                        .renderer_recovery
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .begin(native);
                    monitor_replacement_renderer(handle.clone(), epoch, native);
                }
                log::info!(
                    "[capsule] Native panel rebuilt; active-Space visibility awaits the next show"
                );
                // A new capture can start in the destruction gap. Its earlier
                // show was intentionally deferred; replaying the snapshot in
                // JS renders content but does not order in a native window.
                let needs_show = handle
                    .state::<CapsulePresentation>()
                    .latest()
                    .as_ref()
                    .is_some_and(|state| state.state != "idle");
                if needs_show {
                    if let Err(error) = show_capsule(handle.clone(), None) {
                        log::error!(
                            "[capsule] Could not restore replacement panel visibility: {error}"
                        );
                    }
                }
            }
            Err(error) => {
                health.space_recovery().rebuilt(false);
                log::error!("[capsule] Panel rebuild failed: {error}");
            }
        }
        let _ = reply.send(true);
    })
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
    if panel_replacing(&app) {
        // Native teardown may outlive its timeout. Still accept a valid logical
        // dismissal so a terminal snapshot cannot block the watchdog's retry.
        log::info!("[capsule] Native hide deferred during panel replacement");
    } else if let Ok(panel) = app.get_webview_panel("capsule") {
        // Save on hide, not on every mouse move. The panel retains its frame in memory.
        let frame: NSRect = unsafe { msg_send![&*panel, frame] };
        save_position(&app, frame);
        panel.order_out(None);
    }
    app.state::<CapsuleHealth>().space_recovery().cancel_probe();
    log::info!(
        "[capsule] Hidden: revision={revision:?} for_main_window={}",
        for_main_window.unwrap_or(false)
    );
    SHOWING_FEEDBACK.store(false, Ordering::SeqCst);
    if !for_main_window.unwrap_or(false) {
        app.state::<CapsulePresentation>().clear();
        // Hidden and idle: the only moment a page reload is invisible.
        rebuild_panel_if_needed(&app);
        if !panel_replacing(&app) {
            recycle_if_due(&app);
        }
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

    #[test]
    fn the_pill_keeps_its_place_on_the_display_in_use() {
        let laptop = screen(0.0, 0.0, 1512.0, 945.0);
        let wide = screen(1512.0, -200.0, 2560.0, 1415.0);
        // Bottom centre, 32 pt above the bottom edge.
        let origin = origin_on_screen(NSPoint::new(566.0, 32.0), laptop, wide);
        assert_eq!((origin.x, origin.y), (1512.0 + 1280.0 - 190.0, -168.0));
        // Top right keeps its distance from the top edge.
        let top_right = NSPoint::new(1512.0 - 380.0 - 20.0, 945.0 - 52.0 - 40.0);
        let origin = origin_on_screen(top_right, laptop, wide);
        assert_eq!(origin.y, -200.0 + 1415.0 - 52.0 - 40.0);
        assert!(origin.x + PANEL_WIDTH <= wide.origin.x + wide.size.width);
        // And maps back to where it was.
        let back = origin_on_screen(origin, wide, laptop);
        assert!((back.x - top_right.x).abs() < 1.0 && (back.y - top_right.y).abs() < 1e-9);
    }

    #[test]
    fn a_window_belongs_to_the_display_showing_most_of_it() {
        let left = screen(-1920.0, 0.0, 1920.0, 1080.0);
        let main = screen(0.0, 0.0, 1512.0, 982.0);
        let right = screen(1512.0, 0.0, 2560.0, 1440.0);
        let screens = [main, left, right];
        let straddling = screen(1300.0, 100.0, 800.0, 600.0);
        assert_eq!(screen_for_rect(straddling, &screens), Some(2));
        assert_eq!(
            screen_for_rect(screen(-500.0, 10.0, 200.0, 200.0), &screens),
            Some(1)
        );
        assert_eq!(
            screen_for_rect(screen(9000.0, 0.0, 10.0, 10.0), &screens),
            None
        );
        assert_eq!(
            screen_for_point(NSPoint::new(1512.0, 5.0), &screens),
            Some(2)
        );
        assert_eq!(screen_for_point(NSPoint::new(-1.0, 5.0), &screens), Some(1));
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
