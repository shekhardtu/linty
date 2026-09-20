//! Native macOS menu. Preferences remain owned by the recording/settings stores.
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Listener, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

const TRAY_ID: &str = "main";
const RECENT_TRANSCRIPT_LIMIT: usize = 5;
const TRANSCRIPT_PREVIEW_LENGTH: usize = 52;

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayTranscript {
    transcript_id: String,
    final_text: String,
}

#[derive(Clone, serde::Deserialize)]
struct TrayLanguage {
    code: String,
    label: String,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    status: String,
    local_engine: Option<String>,
    local_ready: bool,
    setup_complete: bool,
    trigger_label: String,
    recent_transcripts: Vec<TrayTranscript>,
    transcription_language: String,
    languages: Vec<TrayLanguage>,
}

struct TrayMenuState(Mutex<TrayState>);

fn snapshot(app: &tauri::AppHandle) -> TrayState {
    let mut state = app
        .state::<TrayMenuState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    // Capture may start before its frontend status event reaches the tray.
    if app
        .state::<crate::state::AppState>()
        .recording
        .lock()
        .map(|r| r.is_recording)
        .unwrap_or(true)
    {
        state.status = "recording".into();
    }
    state
}

fn busy(state: &TrayState) -> bool {
    matches!(
        state.status.as_str(),
        "preparing" | "recording" | "transcribing" | "correcting" | "pasting"
    )
}

fn activity_label(state: &TrayState) -> String {
    match state.status.as_str() {
        "preparing" => "Preparing dictation…".into(),
        "recording" => "Recording…".into(),
        "transcribing" => "Transcribing…".into(),
        "correcting" => "Polishing…".into(),
        "pasting" => "Pasting…".into(),
        "error" => "Check Linty for details".into(),
        _ if !state.setup_complete => "Complete setup in Linty".into(),
        _ => format!("Hold {} to dictate", state.trigger_label),
    }
}

fn local_engine_label(engine: Option<&str>) -> String {
    format!(
        "{} · On-device",
        engine.filter(|s| !s.is_empty()).unwrap_or("Local")
    )
}

fn transcript_preview(text: &str) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = single_line.chars();
    let mut preview: String = chars.by_ref().take(TRANSCRIPT_PREVIEW_LENGTH).collect();
    if chars.next().is_some() {
        preview.push('…');
    }
    // Native menu labels treat ampersands as mnemonic markers.
    preview.replace('&', "&&")
}

fn microphone_menu(
    app: &tauri::AppHandle,
    recording: bool,
) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let input = crate::audio_input::snapshot(app);
    let menu = Submenu::new(app, "Microphone", true)?;
    let default_label = input
        .default_device
        .as_ref()
        .map(|name| format!("System Default — {}", name.replace('&', "&&")))
        .unwrap_or_else(|| "System Default".into());
    menu.append(&CheckMenuItem::with_id(
        app,
        "tray-microphone-default",
        default_label,
        !recording,
        input.selected.is_none(),
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for device in &input.devices {
        let label = if device.selectable {
            device.name.clone()
        } else {
            format!("{} (multiple devices; use System Default)", device.name)
        };
        menu.append(&CheckMenuItem::with_id(
            app,
            format!("tray-microphone-device:{}", device.name),
            label.replace('&', "&&"),
            !recording && device.selectable,
            input.selected.as_ref() == Some(&device.name),
            None::<&str>,
        )?)?;
    }
    if let Some(name) = input
        .selected
        .as_ref()
        .filter(|name| !input.devices.iter().any(|d| &d.name == *name))
    {
        menu.append(&CheckMenuItem::with_id(
            app,
            "tray-microphone-unavailable",
            format!("{} (Unavailable)", name.replace('&', "&&")),
            false,
            true,
            None::<&str>,
        )?)?;
    }
    let notice = if recording {
        Some("Stop recording to change microphone")
    } else if input.error.is_some() {
        Some("Could not list microphones")
    } else if input.devices.is_empty() {
        Some("No microphones connected")
    } else {
        None
    };
    if let Some(notice) = notice {
        menu.append(&MenuItem::with_id(
            app,
            "tray-microphone-notice",
            notice,
            false,
            None::<&str>,
        )?)?;
    }
    Ok(menu)
}

fn build_menu(app: &tauri::AppHandle, state: &TrayState) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let input = crate::audio_input::snapshot(app);
    let input_available = input.error.is_none()
        && match &input.selected {
            Some(name) => input
                .devices
                .iter()
                .any(|d| &d.name == name && d.selectable),
            None => input.default_device.is_some(),
        };
    let ready = state.setup_complete && input_available && !busy(state) && state.status != "error";
    let activity = MenuItem::with_id(
        app,
        "tray-activity",
        activity_label(state),
        false,
        None::<&str>,
    )?;
    let local = MenuItem::with_id(
        app,
        "tray-speech-status",
        if ready && state.local_ready {
            "On-device · Ready"
        } else {
            "On-device"
        },
        false,
        None::<&str>,
    )?;
    let microphone = microphone_menu(app, state.status == "recording")?;
    let selected_language = state
        .languages
        .iter()
        .find(|language| language.code == state.transcription_language);
    let language_title = selected_language
        .map(|language| format!("Language · {}", language.label.replace('&', "&&")))
        .unwrap_or_else(|| "Language".into());
    let language_menu = Submenu::new(
        app,
        language_title,
        !busy(state) && !state.languages.is_empty(),
    )?;
    for language in &state.languages {
        language_menu.append(&CheckMenuItem::with_id(
            app,
            format!("tray-language:{}", language.code),
            language.label.replace('&', "&&"),
            !busy(state),
            language.code == state.transcription_language,
            None::<&str>,
        )?)?;
    }

    let copy_latest = MenuItem::with_id(
        app,
        "tray-copy-latest",
        "Copy Last Transcription",
        !state.recent_transcripts.is_empty(),
        None::<&str>,
    )?;
    let recent = Submenu::new(app, "Recent Transcriptions", true)?;
    if state.recent_transcripts.is_empty() {
        recent.append(&MenuItem::with_id(
            app,
            "tray-recent-empty",
            "No transcriptions yet",
            false,
            None::<&str>,
        )?)?;
    }
    for transcript in state
        .recent_transcripts
        .iter()
        .take(RECENT_TRANSCRIPT_LIMIT)
    {
        recent.append(&MenuItem::with_id(
            app,
            format!("tray-copy:{}", transcript.transcript_id),
            transcript_preview(&transcript.final_text),
            true,
            None::<&str>,
        )?)?;
    }
    recent.append(&PredefinedMenuItem::separator(app)?)?;
    recent.append(&MenuItem::with_id(
        app,
        "tray-history",
        "View History…",
        true,
        None::<&str>,
    )?)?;

    let open = MenuItem::with_id(app, "tray-show", "Open Linty", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        "Quit Linty",
        !busy(state),
        Some("CmdOrCtrl+Q"),
    )?;
    Menu::with_items(
        app,
        &[
            &activity,
            &local,
            &microphone,
            &language_menu,
            &PredefinedMenuItem::separator(app)?,
            &copy_latest,
            &recent,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn refresh_menu(app: &tauri::AppHandle) {
    let state = snapshot(app);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app, &state) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(error) => log::warn!("[tray] Could not refresh menu: {error}"),
        }
        let engine = local_engine_label(state.local_engine.as_deref());
        let _ = tray.set_tooltip(Some(format!(
            "Linty — {} · {engine}",
            activity_label(&state)
        )));
    }
}

fn select_microphone(app: &tauri::AppHandle, name: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = crate::audio_input::select(&app, name) {
            let _ = app.emit("audio-input-error", error);
        }
        // Native checked items toggle before persistence; always restore confirmed state.
        refresh_menu(&app);
    });
}

fn open_app(app: &tauri::AppHandle, destination: &str) {
    let _ = app.emit_to("main", "tray-navigate", destination);
    if let Some(window) = app.get_webview_window("main") {
        super::set_activation_policy_regular();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn copy_transcript(app: &tauri::AppHandle, id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve by ID from storage, so deleted/edited records are never copied from a stale menu.
        let result = crate::history::read_transcript(&app, &id).and_then(|record| {
            let text = record
                .as_ref()
                .and_then(|r| r.get("finalText"))
                .and_then(|v| v.as_str())
                .filter(|text| !text.trim().is_empty())
                .ok_or("This transcription is no longer available.")?;
            app.clipboard()
                .write_text(text)
                .map_err(|_| "Could not copy to the clipboard.".into())
        });
        let _ = app.emit_to("main", "tray-copy-result", result.err());
    });
}

pub fn init_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(TrayMenuState(Mutex::new(TrayState {
        status: "idle".into(),
        local_engine: None,
        local_ready: false,
        setup_complete: false,
        trigger_label: "fn".into(),
        recent_transcripts: vec![],
        transcription_language: String::new(),
        languages: vec![],
    })));
    // Reuse the config-created template icon; AppKit owns all menu presentation and interaction.
    let tray = app.tray_by_id(TRAY_ID).expect("configured tray icon");
    tray.set_menu(Some(build_menu(app.handle(), &snapshot(app.handle()))?))?;
    tray.set_show_menu_on_left_click(true)?;
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "tray-show" => open_app(app, "show"),
        "tray-settings" => open_app(app, "settings"),
        "tray-history" => open_app(app, "history"),
        "tray-quit" => {
            if !busy(&snapshot(app)) {
                app.exit(0);
            }
        }
        "tray-microphone-default" => select_microphone(app, None),
        "tray-copy-latest" => {
            if let Some(transcript) = snapshot(app).recent_transcripts.first() {
                copy_transcript(app, transcript.transcript_id.clone());
            }
        }
        id => {
            if let Some(code) = id.strip_prefix("tray-language:") {
                let state = snapshot(app);
                if !busy(&state) && state.languages.iter().any(|language| language.code == code) {
                    let _ = app.emit_to("main", "tray-language-changed", code);
                }
                refresh_menu(app);
            } else if let Some(name) = id.strip_prefix("tray-microphone-device:") {
                select_microphone(app, Some(name.to_owned()));
            } else if let Some(id) = id.strip_prefix("tray-copy:") {
                copy_transcript(app, id.to_owned());
            }
        }
    });
    let handle = app.handle().clone();
    app.listen("history-invalidated", move |_| {
        // The webview may be suspended while Linty is in the menu bar. Release
        // its native transcript previews as soon as storage removes history.
        handle
            .state::<TrayMenuState>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recent_transcripts
            .clear();
        refresh_menu(&handle);
    });
    let handle = app.handle().clone();
    app.listen("tray-state-changed", move |event| {
        if let Ok(mut state) = serde_json::from_str::<TrayState>(event.payload()) {
            state.recent_transcripts.truncate(RECENT_TRANSCRIPT_LIMIT);
            *handle
                .state::<TrayMenuState>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = state;
            refresh_menu(&handle);
        }
    });
    for event in [
        crate::audio_input::CHANGED,
        "recording-started",
        "recording-stopped",
        "tray-language-result",
    ] {
        let handle = app.handle().clone();
        app.listen(event, move |_| refresh_menu(&handle));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{local_engine_label, transcript_preview};

    #[test]
    fn menu_names_the_selected_local_engine() {
        assert_eq!(local_engine_label(Some("Parakeet")), "Parakeet · On-device");
        assert_eq!(local_engine_label(Some("Whisper")), "Whisper · On-device");
        assert_eq!(local_engine_label(None), "Local · On-device");
    }

    #[test]
    fn previews_preserve_unicode_and_escape_menu_mnemonics() {
        assert_eq!(
            transcript_preview("Hello\n\tworld & friends"),
            "Hello world && friends"
        );
        assert_eq!(
            transcript_preview(&"語".repeat(54)),
            format!("{}…", "語".repeat(52))
        );
    }
}
