//! NSEvent-based fn/globe key monitoring.
//!
//! Uses NSEvent.addGlobalMonitorForEvents (standard AppKit API).
//! Based on the approach used by the open-source VoiceInk (Beingpax/VoiceInk) — now Linty.

use block2::RcBlock;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// ── Objective-C / macOS FFI ──

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
}

/// kCGEventSourceStateHIDSystemState — hardware-level key state.
const CG_EVENT_SOURCE_STATE_HID: i32 = 1;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: i64,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

// kAXTrustedCheckOptionPrompt key
const AX_TRUSTED_CHECK_OPTION_PROMPT: &[u8] = b"AXTrustedCheckOptionPrompt\0";

extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const u8,
        encoding: u32,
    ) -> *const c_void;
    fn CFPreferencesCopyAppValue(
        key: *const c_void,
        application_id: *const c_void,
    ) -> *const c_void;
    fn CFNumberGetValue(number: *const c_void, the_type: i64, value_ptr: *mut c_void) -> bool;
    fn CFGetTypeID(cf: *const c_void) -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFRelease(cf: *const c_void);
}

/// Prompt macOS to show the Accessibility permission dialog
unsafe fn prompt_accessibility() -> bool {
    let key = CFStringCreateWithCString(
        std::ptr::null(),
        AX_TRUSTED_CHECK_OPTION_PROMPT.as_ptr(),
        0x08000100, // kCFStringEncodingUTF8
    );
    let keys = [key];
    let values = [kCFBooleanTrue];
    let dict = CFDictionaryCreate(
        std::ptr::null(),
        keys.as_ptr(),
        values.as_ptr(),
        1,
        &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
        &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
    );
    AXIsProcessTrustedWithOptions(dict)
}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const u8) -> *const c_void;
    fn sel_registerName(name: *const u8) -> *const c_void;
    fn objc_msgSend();
}

// NSEventModifierFlagFunction = 1 << 23
const NS_EVENT_MODIFIER_FLAG_FUNCTION: u64 = 0x80_0000;
// NSEventMaskFlagsChanged = 1 << 12
const NS_EVENT_MASK_FLAGS_CHANGED: u64 = 1 << 12;

/// The modifier-flag bit the monitor treats as the push-to-talk trigger.
/// Defaults to fn; set_trigger_modifier switches it to a device-dependent
/// bit (NX_DEVICE*KEYMASK) so bare left/right modifiers work as triggers.
static TRIGGER_MASK: AtomicU64 = AtomicU64::new(NS_EVENT_MODIFIER_FLAG_FUNCTION);

/// Hardware keycode (kVK_*) of the trigger key, for CGEventSourceKeyState
/// reality checks on release events. Defaults to fn (kVK_Function = 63).
static TRIGGER_KEYCODE: AtomicU32 = AtomicU32::new(63);

/// Map a trigger modifier name to its NSEvent modifierFlags bit and its
/// hardware keycode. Left/right variants use the device-dependent masks from
/// IOKit/hidsystem (present in the low bits of every flagsChanged event).
fn modifier_target(name: &str) -> Option<(u64, u16)> {
    Some(match name {
        "fn" => (NS_EVENT_MODIFIER_FLAG_FUNCTION, 63), // kVK_Function
        "left-control" => (0x0000_0001, 59),           // NX_DEVICELCTLKEYMASK
        "left-shift" => (0x0000_0002, 56),             // NX_DEVICELSHIFTKEYMASK
        "right-shift" => (0x0000_0004, 60),            // NX_DEVICERSHIFTKEYMASK
        "left-command" => (0x0000_0008, 55),           // NX_DEVICELCMDKEYMASK
        "right-command" => (0x0000_0010, 54),          // NX_DEVICERCMDKEYMASK
        "left-option" => (0x0000_0020, 58),            // NX_DEVICELALTKEYMASK
        "right-option" => (0x0000_0040, 61),           // NX_DEVICERALTKEYMASK
        "right-control" => (0x0000_2000, 62),          // NX_DEVICERCTLKEYMASK
        _ => return None,
    })
}

/// Point the monitor at a different trigger modifier. Called from the
/// frontend when the user picks a modifier-hold trigger key.
pub fn set_trigger_modifier(name: &str) -> Result<(), String> {
    let (mask, keycode) =
        modifier_target(name).ok_or_else(|| format!("Unknown trigger modifier: {}", name))?;
    let previous = TRIGGER_MASK.swap(mask, Ordering::SeqCst);
    TRIGGER_KEYCODE.store(keycode as u32, Ordering::SeqCst);
    if previous != mask {
        log::info!(
            "[fnkey] trigger modifier -> {} (mask 0x{:X}, keycode {})",
            name,
            mask,
            keycode
        );
    }
    Ok(())
}

/// True when the trigger key is physically held per hardware state. Used to
/// reject synthetic flagsChanged events with stale flags (focus transitions
/// can deliver those). If the OS ever denies the query it returns false,
/// which degrades to trusting the event — never to a stuck-held state.
fn trigger_key_physically_down() -> bool {
    let keycode = TRIGGER_KEYCODE.load(Ordering::Relaxed) as u16;
    unsafe { CGEventSourceKeyState(CG_EVENT_SOURCE_STATE_HID, keycode) }
}

struct FnKeyState {
    app: AppHandle,
    fn_held: AtomicBool,
    event_count: AtomicU64,
}

/// Payload of `fnkey-pressed` / `fnkey-released`: the key's own time, so the
/// frontend gesture interpreter stays exact even when its webview runs late.
#[derive(Clone, serde::Serialize)]
struct TriggerEvent {
    at: u64,
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wall-clock milliseconds of an NSEvent. Its `timestamp` counts seconds since
/// boot on the mach clock (paused in sleep), the basis of CLOCK_UPTIME_RAW.
/// Falls back to now when the event carries no usable time.
unsafe fn event_wall_ms(event: *const c_void) -> u64 {
    let now = wall_ms();
    let sel = sel_registerName(b"timestamp\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> f64 =
        std::mem::transmute(objc_msgSend as *const c_void);
    let event_seconds = send(event, sel);
    let mut uptime = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if event_seconds <= 0.0 || libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut uptime) != 0 {
        return now;
    }
    let uptime_seconds = uptime.tv_sec as f64 + uptime.tv_nsec as f64 / 1e9;
    let age_ms = ((uptime_seconds - event_seconds) * 1000.0).round();
    if !(0.0..=60_000.0).contains(&age_ms) {
        return now;
    }
    now - age_ms as u64
}

/// Shared by both NSEvent monitors. The native dictation hooks run first (they
/// never wait on a webview); the frontend event follows with the key's own time.
unsafe fn trigger_changed(state: &FnKeyState, event: *const c_void, pressed: bool, local: bool) {
    let at = event_wall_ms(event);
    if pressed {
        if local {
            log::info!("[fnkey] fn PRESSED (local — app focused)");
        } else {
            log::info!("[fnkey] fn PRESSED — starting recording");
        }
        crate::dictation::trigger_pressed(&state.app, at);
        let _ = state.app.emit("fnkey-pressed", TriggerEvent { at });
    } else {
        if local {
            log::info!("[fnkey] fn RELEASED (local — app focused)");
        } else {
            log::info!("[fnkey] fn RELEASED — stopping recording");
        }
        crate::dictation::trigger_released(&state.app, at);
        let _ = state.app.emit("fnkey-released", TriggerEvent { at });
    }
}

// AppKit owns a copy of each RcBlock. Each copied closure owns its Arc, so a
// queued callback keeps its state alive even while monitors are being removed.
unsafe fn global_event(state: &FnKeyState, event: *const c_void) {
    GLOBAL_EVENTS.fetch_add(1, Ordering::Relaxed);

    // Count events for diagnostics
    let count = state.event_count.fetch_add(1, Ordering::SeqCst) + 1;

    // Get [event modifierFlags] -> NSUInteger
    let sel = sel_registerName(b"modifierFlags\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> u64 =
        std::mem::transmute(objc_msgSend as *const c_void);
    let modifier_flags = send(event, sel);

    let fn_pressed = (modifier_flags & TRIGGER_MASK.load(Ordering::Relaxed)) != 0;

    if count <= 5 {
        log::debug!(
            "[fnkey] event #{} flags=0x{:X} fn={}",
            count,
            modifier_flags,
            fn_pressed
        );
    }

    if fn_pressed {
        if !state.fn_held.swap(true, Ordering::SeqCst) {
            trigger_changed(state, event, true, false);
        }
    } else if state.fn_held.swap(false, Ordering::SeqCst) {
        if trigger_key_physically_down() {
            // The event's flags say released, but the hardware says the key
            // is still held — a synthetic flagsChanged with stale flags
            // (focus transition). Stay armed; the real release will produce
            // its own event.
            state.fn_held.store(true, Ordering::SeqCst);
            log::info!("[fnkey] release ignored — trigger key physically still down");
        } else {
            trigger_changed(state, event, false, false);
        }
    }
}

unsafe fn local_event(state: &FnKeyState, event: *const c_void) -> *const c_void {
    LOCAL_EVENTS.fetch_add(1, Ordering::Relaxed);

    let sel = sel_registerName(b"modifierFlags\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> u64 =
        std::mem::transmute(objc_msgSend as *const c_void);
    let modifier_flags = send(event, sel);

    let fn_pressed = (modifier_flags & TRIGGER_MASK.load(Ordering::Relaxed)) != 0;

    if fn_pressed {
        if !state.fn_held.swap(true, Ordering::SeqCst) {
            trigger_changed(state, event, true, true);
        }
    } else if state.fn_held.swap(false, Ordering::SeqCst) {
        if trigger_key_physically_down() {
            state.fn_held.store(true, Ordering::SeqCst);
            log::info!("[fnkey] release ignored — trigger key physically still down (local)");
        } else {
            trigger_changed(state, event, false, true);
        }
    }

    // Return the event so it's not consumed
    event
}

/// Check if accessibility permission is granted via AXIsProcessTrusted.
pub fn is_accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Prompt macOS to show the Accessibility permission dialog.
/// Returns current trust status (usually false until user acts).
pub fn request_accessibility_permission() -> bool {
    unsafe { prompt_accessibility() }
}

/// Read the macOS "Press 🌐 key to" setting (com.apple.HIToolbox AppleFnUsageType).
/// 0 = Do Nothing, 1 = Change Input Source, 2 = Show Emoji & Symbols, 3 = Start Dictation.
/// Returns None when unset — the macOS default applies, which is NOT "Do Nothing",
/// so an unset value still conflicts with fn push-to-talk (issue #32).
pub fn fn_usage_type() -> Option<i64> {
    const UTF8: u32 = 0x08000100; // kCFStringEncodingUTF8
    unsafe {
        let key = CFStringCreateWithCString(std::ptr::null(), b"AppleFnUsageType\0".as_ptr(), UTF8);
        let app_id =
            CFStringCreateWithCString(std::ptr::null(), b"com.apple.HIToolbox\0".as_ptr(), UTF8);
        // CFRelease(NULL) crashes — guard before releasing anything.
        if key.is_null() || app_id.is_null() {
            if !key.is_null() {
                CFRelease(key);
            }
            if !app_id.is_null() {
                CFRelease(app_id);
            }
            return None;
        }
        let value = CFPreferencesCopyAppValue(key, app_id);
        CFRelease(key);
        CFRelease(app_id);
        if value.is_null() {
            return None;
        }

        let mut result = None;
        if CFGetTypeID(value) == CFNumberGetTypeID() {
            let mut n: i64 = 0;
            if CFNumberGetValue(
                value,
                4, /* kCFNumberSInt64Type */
                &mut n as *mut i64 as *mut c_void,
            ) {
                result = Some(n);
            }
        }
        CFRelease(value);
        result
    }
}

/// Set up global fn key monitoring using NSEvent.
/// Must be called from the main thread (Tauri setup closure).
/// Skips monitor setup if accessibility is not granted.
pub fn setup_fn_key_monitor(app: AppHandle) {
    let ax_trusted = unsafe { AXIsProcessTrusted() };
    log::info!("[fnkey] AXIsProcessTrusted = {}", ax_trusted);

    if !ax_trusted {
        log::warn!("[fnkey] Accessibility not granted — skipping monitor setup (will reinit after onboarding)");
        // Store the app handle for later reinitialization
        let mut guard = APP_HANDLE.lock().unwrap();
        *guard = Some(app);
        return;
    }

    init_monitor(app);
}

/// Whether the "not trusted" state has already been logged — the watchdog polls
/// this fn every 30s, so log the state once per transition, not per poll.
static NOT_TRUSTED_LOGGED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq)]
enum MonitorRetry {
    Healthy,
    WaitForRelease,
    Reinitialize { reconcile_release: bool },
}

fn monitor_retry(
    global: bool,
    local: bool,
    physical_held: bool,
    logical_held: bool,
) -> MonitorRetry {
    if global && local {
        MonitorRetry::Healthy
    } else if physical_held {
        MonitorRetry::WaitForRelease
    } else {
        MonitorRetry::Reinitialize {
            reconcile_release: logical_held,
        }
    }
}

fn monitor_held(clear: bool) -> bool {
    let mut held = false;
    if let Ok(guard) = MONITOR_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            held = if clear {
                state.fn_held.swap(false, Ordering::SeqCst)
            } else {
                state.fn_held.load(Ordering::SeqCst)
            };
        }
    }
    held
}

/// Re-initialize the fn key monitor if it isn't running.
/// Called from the frontend after onboarding completes and periodically by the
/// watchdog as a self-healing net (must run on the main thread — NSEvent API).
pub fn reinit_monitor_if_needed(app: AppHandle) {
    // Fast path — monitor healthy; stay silent (this is polled by the watchdog).
    if GLOBAL_ACTIVE.load(Ordering::SeqCst) && LOCAL_ACTIVE.load(Ordering::SeqCst) {
        return;
    }

    let ax_trusted = unsafe { AXIsProcessTrusted() };

    if !ax_trusted {
        if !NOT_TRUSTED_LOGGED.swap(true, Ordering::SeqCst) {
            log::debug!(
                "[fnkey] reinit: accessibility not granted — monitor deferred (retrying silently)"
            );
        }
        return;
    }

    NOT_TRUSTED_LOGGED.store(false, Ordering::SeqCst);
    log::info!("[fnkey] reinit: AXIsProcessTrusted = true");
    match monitor_retry(
        GLOBAL_ACTIVE.load(Ordering::SeqCst),
        LOCAL_ACTIVE.load(Ordering::SeqCst),
        trigger_key_physically_down(),
        monitor_held(false),
    ) {
        MonitorRetry::Healthy | MonitorRetry::WaitForRelease => return,
        MonitorRetry::Reinitialize {
            reconcile_release: true,
        } => {
            // A physical release can precede its queued NSEvent callback, or
            // happen outside the sole working monitor's focus scope. Resolve
            // the native gesture once before discarding the old shared state.
            // Clearing first also prevents a delayed callback duplicating it.
            if monitor_held(true) {
                let at = wall_ms();
                crate::dictation::trigger_released(&app, at);
                let _ = app.emit("fnkey-released", TriggerEvent { at });
                log::info!("[fnkey] reconciled released trigger before partial monitor repair");
            }
        }
        MonitorRetry::Reinitialize {
            reconcile_release: false,
        } => {}
    }
    // A partial installation must be removed before retrying; otherwise its
    // callback/state would be leaked and each event could fire twice.
    teardown_monitors();
    init_monitor(app);
}

#[cfg(test)]
mod retry_tests {
    use super::{monitor_retry, MonitorRetry};

    #[test]
    fn healthy_monitors_never_rebuild_for_held_or_idle_input() {
        for physical in [false, true] {
            for logical in [false, true] {
                assert_eq!(
                    monitor_retry(true, true, physical, logical),
                    MonitorRetry::Healthy
                );
            }
        }
    }

    #[test]
    fn partial_coverage_preserves_held_gestures_and_reconciles_missing_release() {
        for (global, local) in [(true, false), (false, true), (false, false)] {
            for logical in [false, true] {
                assert_eq!(
                    monitor_retry(global, local, true, logical),
                    MonitorRetry::WaitForRelease
                );
            }
            assert_eq!(
                monitor_retry(global, local, false, false),
                MonitorRetry::Reinitialize {
                    reconcile_release: false
                }
            );
            assert_eq!(
                monitor_retry(global, local, false, true),
                MonitorRetry::Reinitialize {
                    reconcile_release: true
                }
            );
        }
    }
}

/// Shared app handle for deferred initialization.
static APP_HANDLE: std::sync::Mutex<Option<AppHandle>> = std::sync::Mutex::new(None);
/// Whether the monitor has been successfully started.
static GLOBAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static LOCAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static GLOBAL_EVENTS: AtomicU64 = AtomicU64::new(0);
static LOCAL_EVENTS: AtomicU64 = AtomicU64::new(0);

/// Installation and delivery are separate facts: no recent events may simply
/// mean the user has not pressed a modifier. Never rebuild based on inactivity.
pub fn health() -> (bool, bool, u64, u64) {
    (
        GLOBAL_ACTIVE.load(Ordering::SeqCst),
        LOCAL_ACTIVE.load(Ordering::SeqCst),
        GLOBAL_EVENTS.load(Ordering::Relaxed),
        LOCAL_EVENTS.load(Ordering::Relaxed),
    )
}

// ── Pointer wrappers for Send safety (these are ObjC monitor IDs, accessed under lock) ──

struct SendPtr(*const c_void);
unsafe impl Send for SendPtr {}

/// Stored monitor pointers for teardown (AppKit owns these until removal).
static GLOBAL_MONITOR: std::sync::Mutex<Option<SendPtr>> = std::sync::Mutex::new(None);
static LOCAL_MONITOR: std::sync::Mutex<Option<SendPtr>> = std::sync::Mutex::new(None);
/// An independent reference for health checks; callbacks own their own Arcs.
static MONITOR_STATE: std::sync::Mutex<Option<Arc<FnKeyState>>> = std::sync::Mutex::new(None);

/// Remove existing NSEvent monitors and reclaim Arc memory. Safe to call even if no monitors exist.
fn teardown_monitors() {
    unsafe {
        let ns_event_class = objc_getClass(b"NSEvent\0".as_ptr());
        let remove_sel = sel_registerName(b"removeMonitor:\0".as_ptr());
        let send_remove: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) =
            std::mem::transmute(objc_msgSend as *const c_void);

        // Remove global monitor
        if let Ok(mut guard) = GLOBAL_MONITOR.lock() {
            if let Some(SendPtr(ptr)) = guard.take() {
                if !ptr.is_null() {
                    send_remove(ns_event_class, remove_sel, ptr);
                    log::debug!("[fnkey] Removed global monitor");
                }
            }
        }

        // Remove local monitor
        if let Ok(mut guard) = LOCAL_MONITOR.lock() {
            if let Some(SendPtr(ptr)) = guard.take() {
                if !ptr.is_null() {
                    send_remove(ns_event_class, remove_sel, ptr);
                    log::debug!("[fnkey] Removed local monitor");
                }
            }
        }

        if let Ok(mut guard) = MONITOR_STATE.lock() {
            guard.take();
        }
    }

    GLOBAL_ACTIVE.store(false, Ordering::SeqCst);
    LOCAL_ACTIVE.store(false, Ordering::SeqCst);
}

/// Epoch millis of the last force reinit — debounces the redundant triggers a
/// single wake produces (system-wake observer, screen-wake observer, frontend).
static LAST_FORCE_REINIT_MS: AtomicU64 = AtomicU64::new(0);
const FORCE_REINIT_DEBOUNCE_MS: u64 = 2000;

/// Tear down existing monitors and re-initialize. Called on system wake.
pub fn force_reinit_monitor(app: AppHandle) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let last = LAST_FORCE_REINIT_MS.load(Ordering::SeqCst);
    if now.saturating_sub(last) < FORCE_REINIT_DEBOUNCE_MS {
        log::debug!("[fnkey] force_reinit skipped (debounced)");
        return;
    }
    LAST_FORCE_REINIT_MS.store(now, Ordering::SeqCst);
    log::info!("[fnkey] force_reinit — tearing down and re-creating monitors");
    teardown_monitors();
    init_monitor(app);
}

fn init_monitor(app: AppHandle) {
    let state = Arc::new(FnKeyState {
        app,
        fn_held: AtomicBool::new(false),
        event_count: AtomicU64::new(0),
    });

    if let Ok(mut guard) = MONITOR_STATE.lock() {
        *guard = Some(Arc::clone(&state));
    }

    unsafe {
        let ns_event_class = objc_getClass(b"NSEvent\0".as_ptr());

        // Do not hand-build blocks: an incorrect isa makes AppKit retain the
        // original allocation rather than copy it, leaving a dangling callback
        // when Rust frees it (GlobalObserverHandler SIGBUS in 0.0.18).
        let global_state = Arc::clone(&state);
        let block = RcBlock::new(move |event: *const c_void| {
            global_event(&global_state, event);
        });

        let sel = sel_registerName(b"addGlobalMonitorForEventsMatchingMask:handler:\0".as_ptr());
        let send: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            u64,
            *const c_void,
        ) -> *const c_void = std::mem::transmute(objc_msgSend as *const c_void);

        let monitor = send(
            ns_event_class,
            sel,
            NS_EVENT_MASK_FLAGS_CHANGED,
            RcBlock::as_ptr(&block).cast(),
        );

        if monitor.is_null() {
            log::error!("[fnkey] NSEvent global monitor FAILED");
        } else {
            log::info!("[fnkey] NSEvent global monitor active");
            if let Ok(mut g) = GLOBAL_MONITOR.lock() {
                *g = Some(SendPtr(monitor));
            }
        }

        let local_block = RcBlock::new(move |event: *const c_void| local_event(&state, event));

        let local_sel =
            sel_registerName(b"addLocalMonitorForEventsMatchingMask:handler:\0".as_ptr());
        let local_send: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            u64,
            *const c_void,
        ) -> *const c_void = std::mem::transmute(objc_msgSend as *const c_void);

        let local_monitor = local_send(
            ns_event_class,
            local_sel,
            NS_EVENT_MASK_FLAGS_CHANGED,
            RcBlock::as_ptr(&local_block).cast(),
        );

        if local_monitor.is_null() {
            log::error!("[fnkey] NSEvent local monitor FAILED");
        } else {
            log::info!("[fnkey] NSEvent local monitor active");
            if let Ok(mut g) = LOCAL_MONITOR.lock() {
                *g = Some(SendPtr(local_monitor));
            }
        }

        GLOBAL_ACTIVE.store(!monitor.is_null(), Ordering::SeqCst);
        LOCAL_ACTIVE.store(!local_monitor.is_null(), Ordering::SeqCst);
        if !monitor.is_null() && !local_monitor.is_null() {
            log::info!("[fnkey] fn key monitoring ready — press fn to record");
        } else {
            log::warn!(
                "[fnkey] incomplete trigger coverage: global={} local={}; retry scheduled",
                !monitor.is_null(),
                !local_monitor.is_null()
            );
        }
    }
}
