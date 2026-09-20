//! One native microphone preference shared by recording, the tray, and Settings.
use cpal::traits::{DeviceTrait, HostTrait};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

const STORE: &str = "linty-settings.json";
const PREFERENCE: &str = "audioInputName";
pub const CHANGED: &str = "audio-input-changed";

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub selectable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSnapshot {
    pub selected: Option<String>,
    pub default_device: Option<String>,
    pub devices: Vec<InputDevice>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct AudioInputState(Mutex<InputSnapshot>);

fn device_choices(names: impl Iterator<Item = String>) -> Vec<InputDevice> {
    // CPAL 0.15 exposes names, not persistent device IDs. Never silently choose
    // between identically named devices; System Default remains usable for them.
    let mut counts = BTreeMap::new();
    for name in names {
        *counts.entry(name).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .map(|(name, count)| InputDevice {
            name,
            selectable: count == 1,
        })
        .collect()
}

fn inventory() -> Result<(Vec<InputDevice>, Option<String>), String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("Could not list microphones: {e}"))?;
    let names = devices
        .map(|device| device.name())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not read microphone names: {e}"))?;
    let default = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    Ok((device_choices(names.into_iter()), default))
}

pub fn snapshot(app: &tauri::AppHandle) -> InputSnapshot {
    app.state::<AudioInputState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn refresh(app: &tauri::AppHandle) -> InputSnapshot {
    let inventory = inventory();
    let state = app.state::<AudioInputState>();
    let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let previous = current.clone();
    match inventory {
        Ok((devices, default)) => {
            current.devices = devices;
            current.default_device = default;
            current.error = None;
        }
        Err(error) => {
            current.devices.clear();
            current.default_device = None;
            current.error = Some(error);
        }
    }
    let next = current.clone();
    drop(current);
    if next != previous {
        let _ = app.emit(CHANGED, &next);
    }
    next
}

/// Resolve again at recording start, so unplugged devices never silently fall
/// back to another microphone. None deliberately follows the macOS default.
pub fn resolve_device(selected: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let Some(name) = selected else {
        return host
            .default_input_device()
            .ok_or_else(|| "No microphone is available. Connect one and try again.".into());
    };
    let mut matches = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter(|device| device.name().is_ok_and(|candidate| candidate == name));
    let device = matches.next().ok_or_else(|| {
        format!("{name} is unavailable. Choose a microphone from Linty’s menu bar menu.")
    })?;
    if matches.next().is_some() {
        return Err("Multiple microphones have that name. Choose System Default and select the input in macOS.".into());
    }
    Ok(device)
}

fn validate_selection(
    selected: Option<&str>,
    devices: &[InputDevice],
    recording: bool,
) -> Result<(), String> {
    if recording {
        return Err("Stop recording before changing the microphone.".into());
    }
    if let Some(name) = selected {
        if !devices
            .iter()
            .any(|device| device.name == name && device.selectable)
        {
            return Err("That microphone is no longer available. Choose another input.".into());
        }
    }
    Ok(())
}

pub fn select(app: &tauri::AppHandle, selected: Option<String>) -> Result<InputSnapshot, String> {
    let available = refresh(app);
    let recording = app.state::<crate::state::AppState>();
    // The same lock guards recording startup, so selection cannot race capture.
    let recording = recording.recording.lock().map_err(|e| e.to_string())?;
    validate_selection(
        selected.as_deref(),
        &available.devices,
        recording.is_recording,
    )?;
    let state = app.state::<AudioInputState>();
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let previous = store.get(PREFERENCE);
    store.set(PREFERENCE, serde_json::json!(selected));
    if let Err(error) = store.save() {
        match previous {
            Some(value) => store.set(PREFERENCE, value),
            None => {
                store.delete(PREFERENCE);
            }
        }
        return Err(format!("Could not save microphone selection: {error}"));
    }
    current.selected = selected;
    let next = current.clone();
    drop(current);
    drop(recording);
    let _ = app.emit(CHANGED, &next);
    Ok(next)
}

#[tauri::command(async)]
pub fn get_audio_inputs(app: tauri::AppHandle) -> InputSnapshot {
    refresh(&app)
}

#[tauri::command(async)]
pub fn set_audio_input(
    app: tauri::AppHandle,
    name: Option<String>,
) -> Result<InputSnapshot, String> {
    select(&app, name)
}

pub fn reset(app: &tauri::AppHandle) {
    let state = app.state::<AudioInputState>();
    state.0.lock().unwrap_or_else(|e| e.into_inner()).selected = None;
    let _ = app.emit(CHANGED, snapshot(app));
}

pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let selected = app
        .store(STORE)?
        .get(PREFERENCE)
        .and_then(|value| value.as_str().map(str::to_owned));
    app.state::<AudioInputState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .selected = selected;
    refresh(app);
    let handle = app.clone();
    // Device enumeration does not open a recording stream or request mic access.
    // Refresh independently of the webview so menu-only use sees hot-plug changes.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        refresh(&handle);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_inputs_must_exist_and_switching_is_blocked_during_recording() {
        let devices = device_choices(["Built-in", "USB"].into_iter().map(str::to_owned));
        assert!(validate_selection(Some("USB"), &devices, false).is_ok());
        assert!(validate_selection(None, &[], false).is_ok());
        assert!(validate_selection(Some("Disconnected"), &devices, false).is_err());
        assert!(validate_selection(Some("USB"), &devices, true).is_err());
        assert!(validate_selection(None, &devices, true).is_err());
    }

    #[test]
    fn duplicate_names_are_not_silently_bound_to_the_wrong_microphone() {
        let devices = device_choices(["USB", "Built-in", "USB"].into_iter().map(str::to_owned));
        assert_eq!(devices.len(), 2);
        assert!(validate_selection(Some("USB"), &devices, false).is_err());
        assert!(validate_selection(Some("Built-in"), &devices, false).is_ok());
        assert!(validate_selection(None, &devices, false).is_ok());
    }
}
