use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::cocoa::appkit::{NSMainMenuWindowLevel, NSWindowCollectionBehavior};
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
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hands_free: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

#[tauri::command]
#[allow(unexpected_cfgs)]
pub fn show_capsule(app: AppHandle, feedback: Option<bool>) {
    let Ok(panel) = app.get_webview_panel("capsule") else {
        log::warn!("[capsule] show_capsule: panel not found");
        return;
    };

    // Re-apply critical properties every show — macOS may reset them after
    // sleep/wake, display reconfiguration, or space changes.
    panel.set_level(PANEL_LEVEL);
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);

    // Wake the capsule webview's JS context — macOS may suspend WKWebView
    // for hidden windows. Evaluating JS forces the content process to resume
    // before we send state events.
    if let Some(capsule_window) = app.get_webview_window("capsule") {
        let _ = capsule_window.eval("/* wake */");
    }

    // Reuse the actual native position after dragging, including between states.
    // First show restores the previous app session; fresh installs start at bottom center.
    unsafe {
        let main_screen = tauri_nspanel::cocoa::appkit::NSScreen::mainScreen(nil);
        if main_screen == nil {
            return;
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
    SHOWING_FEEDBACK.store(feedback.unwrap_or(false), Ordering::SeqCst);
}

#[tauri::command]
pub fn hide_capsule(app: AppHandle, feedback: Option<bool>) {
    if SHOWING_FEEDBACK.load(Ordering::SeqCst) != feedback.unwrap_or(false) {
        return;
    }
    let Ok(panel) = app.get_webview_panel("capsule") else {
        return;
    };
    // Save on hide, not on every mouse move. The panel retains its frame in memory.
    let frame: NSRect = unsafe { msg_send![&*panel, frame] };
    save_position(&app, frame);
    panel.order_out(None);
    SHOWING_FEEDBACK.store(false, Ordering::SeqCst);
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

// ── Emit state ──

#[tauri::command]
pub fn emit_capsule_state(
    app: AppHandle,
    state: String,
    hands_free: Option<bool>,
    generation: Option<u64>,
    error: Option<String>,
) {
    if state == "idle" && SHOWING_FEEDBACK.load(Ordering::SeqCst) {
        return;
    }
    SHOWING_FEEDBACK.store(false, Ordering::SeqCst);
    let payload = CapsuleState {
        state,
        hands_free,
        generation,
        error,
    };
    let _ = app.emit_to("capsule", "capsule-state", &payload);
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
