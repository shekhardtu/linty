//! Native pre-publication rehearsal. Uses the real capsule implementation and
//! renderer, an isolated app identifier, and a synthetic coordinator. No audio,
//! key monitoring, model loading, paste, updater or installed-app changes.
#![allow(dead_code, deprecated, unexpected_cfgs)]

#[path = "../src/capsule.rs"]
mod capsule;
#[path = "../src/responsiveness.rs"]
mod responsiveness;
// This rehearsal installs no event monitor or user hotkeys.
mod fnkey {
    pub fn health() -> (bool, bool, u64, u64) {
        (false, false, 0, 0)
    }
}

mod dictation {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    #[derive(Default)]
    pub struct Coordinator {
        pub active: AtomicBool,
        pub generation: AtomicU64,
    }
    impl Coordinator {
        pub fn capture_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
        pub fn is_current(&self, generation: u64) -> bool {
            self.generation.load(Ordering::SeqCst) == generation
        }
    }
}

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_nspanel::objc::{msg_send, sel, sel_impl};
use tauri_nspanel::ManagerExt;

static PASSED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_theme() -> &'static str {
    "dark"
}

#[tauri::command]
fn rehearsal_renderer_probe(url: String, ready: String) {
    eprintln!("Renderer timeout probe replied: url={url} ready={ready}");
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    let (reply, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = reply.send(work(handle));
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| "Native main-thread step timed out".to_string())?
        .map_err(|error| error.to_string())?
}

#[derive(Debug)]
struct PanelStatus {
    number: u64,
    visible: bool,
    active_space: bool,
    alpha: f64,
    animation_behavior: isize,
}

async fn status(app: &AppHandle) -> Result<PanelStatus, String> {
    on_main(app, |app| {
        let panel = app
            .get_webview_panel("capsule")
            .map_err(|e| format!("{e:?}"))?;
        unsafe {
            Ok(PanelStatus {
                number: msg_send![&*panel, windowNumber],
                visible: msg_send![&*panel, isVisible],
                active_space: msg_send![&*panel, isOnActiveSpace],
                alpha: msg_send![&*panel, alphaValue],
                animation_behavior: msg_send![&*panel, animationBehavior],
            })
        }
    })
    .await
}

fn present(app: AppHandle, generation: u64) -> Result<(), String> {
    let coordinator = app.state::<dictation::Coordinator>();
    coordinator.generation.store(generation, Ordering::SeqCst);
    coordinator.active.store(true, Ordering::SeqCst);
    capsule::emit_capsule_state(
        app.clone(),
        "recording".into(),
        Some(true),
        Some(generation),
        None,
    );
    capsule::show_capsule(app, None)
}

fn dismiss(app: AppHandle) {
    app.state::<dictation::Coordinator>()
        .active
        .store(false, Ordering::SeqCst);
    capsule::emit_capsule_state(app.clone(), "idle".into(), None, None, None);
    capsule::hide_capsule(app, None, None, None);
}

async fn wait_rendered(app: &AppHandle, generation: u64) -> Result<(), String> {
    for _ in 0..100 {
        if capsule::rehearsal_rendered_generation() == generation {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let diagnostic = on_main(app, |app| {
        let windows: Vec<_> = app.webview_windows().keys().cloned().collect();
        eprintln!("Timeout webview-window registry: {windows:?}");
        if let Some(window) = app.get_webview_window("capsule") {
            // The native URL may still be nil before the first commit. Report
            // configuration without invoking Wry's nullable-URL getter.
            eprintln!("Timeout capsule configured URL: {:?}", app.config().app.windows.iter().find(|config| config.label == "capsule").map(|config| &config.url));
            let native = window.with_webview(|webview| unsafe {
                let view = webview.inner() as tauri_nspanel::cocoa::base::id;
                let responds: bool = msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
                let pid: i32 = if responds { msg_send![view, _webProcessIdentifier] } else { -1 };
                let delegate: tauri_nspanel::cocoa::base::id = msg_send![view, navigationDelegate];
                let handles_policy: bool = if delegate.is_null() { false } else { msg_send![delegate, respondsToSelector: sel!(webView:decidePolicyForNavigationAction:decisionHandler:)] };
                eprintln!("Timeout navigation delegate: pointer={delegate:p} handles_policy={handles_policy}");
                let loading: bool = msg_send![view, isLoading];
                let progress: f64 = msg_send![view, estimatedProgress];
                let alive = pid > 0 && libc::kill(pid, 0) == 0;
                eprintln!("Timeout WKWebView: pid={pid} alive={alive} loading={loading} progress={progress}");
            });
            eprintln!("Timeout native inspection dispatch: {native:?}");
            eprintln!("Timeout renderer eval dispatch: {:?}", window.eval(r#"window.__TAURI_INTERNALS__.invoke('rehearsal_renderer_probe', {url: location.href, ready: document.readyState}).catch(console.error)"#));
        }
        Ok(())
    }).await;
    eprintln!(
        "Timeout diagnostics main dispatch={diagnostic:?}; panel={:?}",
        status(app).await
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    Err(format!(
        "Renderer did not acknowledge generation {generation}"
    ))
}

async fn rehearse(app: &AppHandle) -> Result<(), String> {
    // Deliberately stall ONLY this isolated test application's main thread.
    // The independent probe must diagnose it while the run loop cannot reply,
    // then observe recovery. No installed Linty process is touched.
    tokio::time::sleep(Duration::from_secs(3)).await;
    app.run_on_main_thread(|| std::thread::sleep(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    for _ in 0..180 {
        if responsiveness::rehearsal_health() == (1, 1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if responsiveness::rehearsal_health() != (1, 1) {
        return Err(format!(
            "Main-thread stall/recovery not observed: {:?}",
            responsiveness::rehearsal_health()
        ));
    }
    let cycles = rehearsal_cycles()?;
    // Repeated usage, including timer cancellation between presentations.
    for generation in 1..=cycles {
        on_main(app, move |app| present(app, generation)).await?;
        wait_rendered(app, generation).await?;
        let panel = status(app).await?;
        if !panel.visible
            || !panel.active_space
            || panel.alpha < 0.99
            || panel.animation_behavior != capsule::NS_WINDOW_ANIMATION_BEHAVIOR_NONE
        {
            return Err(format!("Cycle {generation} not visible: {panel:?}"));
        }
        on_main(app, |app| {
            dismiss(app);
            Ok(())
        })
        .await?;
    }

    on_main(app, |app| capsule::rehearse_detached_dismissal(&app)).await?;

    on_main(app, |app| {
        present(app.clone(), 500)?;
        capsule::simulate_failed_panel(&app);
        capsule::show_capsule(app, None)
    })
    .await?;
    wait_rendered(app, 500).await?;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let failed = status(app).await?;
    if !failed.visible || failed.alpha != 0.0 {
        return Err(format!(
            "Failure simulation did not take effect: {failed:?}"
        ));
    }
    // Rebuilding must wait while the synthetic capture remains active.
    on_main(app, |app| {
        capsule::rebuild_panel_if_needed(&app);
        Ok(())
    })
    .await?;
    if status(app).await?.number != failed.number {
        return Err("Panel was replaced during active capture".into());
    }
    on_main(app, |app| {
        dismiss(app.clone());
        // Deliberately land a fresh state in the destruction/replacement gap.
        present(app, 501)
    })
    .await?;
    wait_rendered(app, 501).await?;
    let restored = status(app).await?;
    if restored.number == failed.number
        || !restored.visible
        || !restored.active_space
        || restored.alpha < 0.99
        || restored.animation_behavior != capsule::NS_WINDOW_ANIMATION_BEHAVIOR_NONE
    {
        return Err(format!(
            "Replacement was not visibly restored: {restored:?}"
        ));
    }
    if std::env::var_os("LINTY_RECOVERY_INSPECT").is_some() {
        eprintln!("Replacement verified; holding the visible test pill for 30 seconds.");
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
    on_main(app, |app| {
        dismiss(app);
        Ok(())
    })
    .await?;
    Ok(())
}

fn rehearsal_cycles() -> Result<u64, String> {
    let cycles = std::env::var("LINTY_CAPSULE_RECOVERY_CYCLES")
        .unwrap_or_else(|_| "200".into())
        .parse::<u64>()
        .map_err(|_| "Rehearsal cycles must be an integer".to_string())?;
    if !(1..=400).contains(&cycles) {
        return Err("Rehearsal cycles must be between 1 and 400".into());
    }
    Ok(cycles)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout)]).build())
        .manage(capsule::CapsulePresentation::default())
        .manage(capsule::CapsuleHealth::default())
        .manage(dictation::Coordinator::default())
        .invoke_handler(tauri::generate_handler![
            get_theme, rehearsal_renderer_probe, capsule::capsule_state_rendered, capsule::get_capsule_state,
            capsule::show_capsule, capsule::hide_capsule, capsule::is_dictation_window_active,
        ])
        .on_web_content_process_terminate(|webview| {
            eprintln!("Rehearsal web content process terminated: {}", webview.label());
        })
        .on_page_load(|webview, payload| {
            eprintln!("Rehearsal page load: label={} {:?} {}", webview.label(), payload.event(), payload.url());
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                eprintln!("Rehearsal window destroyed: {}", window.label());
            }
        })
        .setup(|app| {
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            capsule::init_capsule_panel(app.handle());
            capsule::register_space_observer(app.handle());
            responsiveness::start(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = rehearse(&handle).await;
                match result {
                    Ok(()) => {
                        if let Some(path) = std::env::var_os("LINTY_CAPSULE_RECOVERY_REPORT") {
                            let report = serde_json::json!({"passed": true, "cycles": rehearsal_cycles().unwrap_or(0), "injected_failure": true, "replacement_generation": 501, "replacement_navigation_retries": capsule::rehearsal_navigation_retries(), "main_thread_stalls": responsiveness::rehearsal_health().0, "main_thread_recoveries": responsiveness::rehearsal_health().1});
                            if let Err(error) = std::fs::write(path, report.to_string()) {
                                eprintln!("FAIL: Could not save rehearsal evidence: {error}");
                                handle.exit(1);
                                return;
                            }
                        }
                        PASSED.store(true, Ordering::SeqCst);
                        eprintln!("PASS: {} native presentation cycles; invisible-panel simulation; idle-only rebuild; new generation rendered on replacement; active Space and opacity verified.", rehearsal_cycles().unwrap_or(0));
                        handle.exit(0);
                    }
                    Err(error) => {
                        eprintln!("FAIL: {error}");
                        if let Some(path) = std::env::var_os("LINTY_CAPSULE_RECOVERY_REPORT") {
                            let report = serde_json::json!({"passed": false, "cycles": rehearsal_cycles().unwrap_or(0), "error": error, "last_rendered_generation": capsule::rehearsal_rendered_generation(), "replacement_navigation_retries": capsule::rehearsal_navigation_retries(), "main_thread_stalls": responsiveness::rehearsal_health().0, "main_thread_recoveries": responsiveness::rehearsal_health().1});
                            if let Err(write_error) = std::fs::write(path, report.to_string()) {
                                eprintln!("Could not preserve failed rehearsal report: {write_error}");
                            }
                        }
                        if std::env::var_os("LINTY_RECOVERY_INSPECT").is_some() {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Native capsule recovery rehearsal");
    std::process::exit(if PASSED.load(Ordering::SeqCst) { 0 } else { 1 });
}
