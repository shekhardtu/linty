//! Opt-in, local editor assistance. Selection content is never logged or persisted.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
static NEXT_EDIT: AtomicU64 = AtomicU64::new(1);
// Serialize only foreign AX writes, on blocking workers. The preview/controller
// locks remain free while the host responds.
static EDIT_WRITE: Mutex<()> = Mutex::new(());
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Default)]
pub(crate) struct Capture {
    pub terms: Vec<String>,
    #[cfg(target_os = "macos")]
    target: Option<crate::corrections::accessibility::Target>,
}
pub(crate) fn capture(app: &tauri::AppHandle, ide: bool, editing: bool) -> Capture {
    let mut result = Capture::default();
    #[cfg(target_os = "macos")]
    if ide || editing {
        if let Some(target) = crate::corrections::accessibility::Target::focused(app) {
            let selected = target.selected_text().unwrap_or_default();
            if ide && target.application.bundle_id.as_deref().is_some_and(is_ide) {
                result.terms = identifiers(&selected);
            }
            if editing && !selected.trim().is_empty() && selected.encode_utf16().count() <= 4096 {
                result.target = Some(target);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, ide, editing);
    result
}
fn is_ide(id: &str) -> bool {
    matches!(
        id,
        "com.microsoft.VSCode"
            | "com.microsoft.VSCodeInsiders"
            | "com.todesktop.230313mzl4w4u92"
            | "dev.zed.Zed"
            | "com.apple.dt.Xcode"
    ) || id.starts_with("com.jetbrains.")
}
fn identifiers(text: &str) -> Vec<String> {
    if text.encode_utf16().count() > 4096 {
        return vec![];
    }
    let mut result = Vec::new();
    for word in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
        if word.len() < 3
            || word.len() > 64
            || !word.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            || !(word.contains('_') || word.chars().skip(1).any(|c| c.is_ascii_uppercase()))
        {
            continue;
        }
        if !result.iter().any(|v: &String| v.eq_ignore_ascii_case(word)) {
            result.push(word.to_owned());
        }
        if result.len() == 20 {
            break;
        }
    }
    result
}
pub(crate) fn add_terms(options: &mut crate::dictation::Options, terms: &[String]) {
    for term in terms {
        let extra = format!(" {term}");
        if options.prompt.chars().count() + extra.chars().count() <= 600 {
            options.prompt.push_str(&extra);
        }
        if options.vocabulary.len() < 50
            && !options
                .vocabulary
                .iter()
                .any(|v| v.text.eq_ignore_ascii_case(term))
        {
            options.vocabulary.push(crate::vocabulary::VocabTerm {
                text: term.clone(),
                aliases: vec![],
            });
        }
    }
}
fn transform(command: &str, original: &str) -> Option<String> {
    let command = command
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .to_ascii_lowercase();
    Some(match command.as_str() {
        "linty uppercase" => original.to_uppercase(),
        "linty lowercase" => original.to_lowercase(),
        "linty trim" => original.trim().to_owned(),
        "linty bullet list" => original
            .lines()
            .filter(|v| !v.trim().is_empty())
            .map(|v| format!("• {}", v.trim()))
            .collect::<Vec<_>>()
            .join("\n"),
        "linty sentence case" => {
            let mut start = true;
            let mut output = String::new();
            for c in original.chars() {
                if start && c.is_alphabetic() {
                    output.extend(c.to_uppercase());
                    start = false;
                } else {
                    output.extend(c.to_lowercase());
                }
                if matches!(c, '.' | '!' | '?' | '\n') {
                    start = true;
                }
            }
            output
        }
        _ => return None,
    })
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    id: String,
    original: String,
    replacement: String,
}
#[cfg(target_os = "macos")]
struct Pending {
    preview: Preview,
    target: crate::corrections::accessibility::Target,
    created: Instant,
    range_start: usize,
}
#[cfg(target_os = "macos")]
static UNDO: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
#[cfg(target_os = "macos")]
static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
#[cfg(target_os = "macos")]
fn pending() -> &'static Mutex<Option<Pending>> {
    PENDING.get_or_init(|| Mutex::new(None))
}
pub(crate) fn preview(
    app: &tauri::AppHandle,
    capture: &Mutex<Capture>,
    raw: &str,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let mut capture = capture
            .lock()
            .map_err(|_| "Selection capture unavailable")?;
        if transform(raw, "").is_none() {
            return Ok(false);
        }
        let Some(target) = capture.target.as_ref() else {
            return Err("Select accessible text before using a Linty editing command. Your command was saved in History.".into());
        };
        let original = target.selected_text().unwrap_or_default();
        let Some(replacement) = transform(raw, &original) else {
            return Ok(false);
        };
        let target = capture
            .target
            .take()
            .ok_or("Selection capture unavailable")?;
        let preview = Preview {
            id: format!(
                "edit-{}-{}",
                crate::now_epoch_ms(),
                NEXT_EDIT.fetch_add(1, Ordering::Relaxed)
            ),
            original,
            replacement,
        };
        *pending().lock().map_err(|_| "Edit preview unavailable")? = Some(Pending {
            preview: preview.clone(),
            target,
            created: Instant::now(),
            range_start: 0,
        });
        let expires = preview.id.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(120)).await;
            if let Ok(mut guard) = pending().lock() {
                if guard.as_ref().is_some_and(|p| p.preview.id == expires) {
                    *guard = None;
                }
            }
        });
        app.emit_to("main", "editor-edit-preview", preview)
            .map_err(|e| e.to_string())?;
        // Opening Linty is deliberate: editing always requires a visible preview.
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, capture, raw);
        Ok(false)
    }
}
#[tauri::command]
pub async fn accept_editor_edit(id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return tokio::task::spawn_blocking(move || {
        let _write = EDIT_WRITE
            .lock()
            .map_err(|_| "Editor operation unavailable")?;
        let mut guard = pending().lock().map_err(|_| "Edit preview unavailable")?;
        if !guard.as_ref().is_some_and(|p| p.preview.id == id) {
            return Err("This edit preview has expired".into());
        }
        let edit = guard.take().ok_or("This edit has expired")?;
        // Never hold the controller mutex while a foreign process answers AX.
        // Cancel and expiry must not block the main run loop behind that read.
        drop(guard);
        if edit.created.elapsed() > Duration::from_secs(120) {
            return Err("This edit preview has expired; select the text again".into());
        }
        crate::corrections::stop();
        let start = edit.target.selection.start;
        let after = edit
            .target
            .replace_selected_if_unchanged(&edit.preview.replacement)?;
        let mut undo_preview = edit.preview;
        undo_preview.id = id.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(120)).await;
            if let Ok(mut guard) = UNDO.get_or_init(|| Mutex::new(None)).lock() {
                if guard.as_ref().is_some_and(|p| p.preview.id == id) {
                    *guard = None;
                }
            }
        });
        let target = after;
        *UNDO
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "Undo unavailable")? = Some(Pending {
            preview: undo_preview,
            target,
            created: Instant::now(),
            range_start: start,
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("Selected-text editing is only available on macOS".into())
    }
}

#[tauri::command]
pub async fn undo_editor_edit(id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return tokio::task::spawn_blocking(move || {
        let _write = EDIT_WRITE
            .lock()
            .map_err(|_| "Editor operation unavailable")?;
        let mut guard = UNDO
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "Undo unavailable")?;
        if !guard.as_ref().is_some_and(|p| p.preview.id == id) {
            return Err("Undo has expired".into());
        }
        let edit = guard.take().ok_or("This edit has expired")?;
        // Never hold the controller mutex while a foreign process answers AX.
        // Cancel and expiry must not block the main run loop behind that read.
        drop(guard);
        if edit.created.elapsed() > Duration::from_secs(120) {
            return Err("Undo has expired; use the editor’s own Undo".into());
        }
        let start = edit.range_start;
        edit.target.undo_replacement_if_unchanged(
            start..start + edit.preview.replacement.encode_utf16().count(),
            &edit.preview.original,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("Selected-text editing is only available on macOS".into())
    }
}

#[tauri::command]
pub fn cancel_editor_edit(id: String) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(mut guard) = pending().lock() {
            if guard.as_ref().is_some_and(|p| p.preview.id == id) {
                *guard = None;
            }
        }
        if let Ok(mut guard) = UNDO.get_or_init(|| Mutex::new(None)).lock() {
            if guard.as_ref().is_some_and(|p| p.preview.id == id) {
                *guard = None;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_are_explicit_and_deterministic() {
        assert_eq!(
            transform("Linty uppercase.", "Hello café"),
            Some("HELLO CAFÉ".into())
        );
        assert_eq!(transform("uppercase", "Hello"), None);
        assert_eq!(transform("Linty lowercase please", "Hello"), None);
        assert_eq!(
            transform("Linty bullet list", " one\n\n two "),
            Some("• one\n• two".into())
        );
        assert_eq!(
            transform("Linty sentence case", "hELLO. wORLD!"),
            Some("Hello. World!".into())
        );
    }
    #[test]
    fn identifiers_are_bounded_unique_and_code_specific() {
        assert_eq!(
            identifiers("const myValue = snake_case + myValue; 123abc"),
            vec!["myValue", "snake_case"]
        );
        assert!(identifiers(&"a".repeat(4097)).is_empty());
        assert!(!is_ide("com.apple.Terminal"));
    }
}
