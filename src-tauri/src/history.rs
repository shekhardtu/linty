//! Narrow native commands keep the database and exports off the UI thread.
use crate::history_db::{Bucket, DeletedTranscript, HistoryDb, CLEANUP_INTERVAL_MS};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct HistoryState(pub Mutex<()>, AtomicI64, AtomicI64, tokio::sync::Notify);
impl Default for HistoryState {
    fn default() -> Self {
        Self(
            Mutex::new(()),
            AtomicI64::new(-1),
            AtomicI64::new(-1),
            tokio::sync::Notify::new(),
        )
    }
}
impl HistoryState {
    pub fn capture_consent(&self) -> Option<i64> {
        let epoch = self.1.load(Ordering::Acquire);
        (epoch >= 0).then_some(epoch)
    }
    pub fn forget_audio_consent(&self) {
        self.1.store(-1, Ordering::Release);
    }
    fn cache_audio_consent(&self, epoch: Option<i64>) {
        self.1.store(epoch.unwrap_or(-1), Ordering::Release);
    }
    fn cleanup_due(&self, now: i64) -> bool {
        let due = self.2.load(Ordering::Acquire);
        // -1 initializes the archive; 0 means indefinite retention, with no timer.
        due != 0 && due <= now
    }
    fn cache_cleanup_due_at(&self, due: Option<i64>) {
        let due = due.map_or(0, |due| due.max(1));
        if self.2.swap(due, Ordering::AcqRel) != due {
            self.3.notify_one();
        }
    }
}

// Disk I/O, encoding and the archive mutex belong on blocking workers. They
// must not occupy the event loop or the async workers servicing microphone IPC.
async fn worker<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || work(app))
        .await
        .map_err(|_| "History worker was interrupted".to_string())?
}

pub fn initialize(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = maintain_retention(app.clone()).await {
                log::warn!("[history] Retention cleanup failed: {}", error);
                // Avoid a busy retry loop if the disk is unavailable.
                app.state::<HistoryState>()
                    .cache_cleanup_due_at(Some(now().saturating_add(CLEANUP_INTERVAL_MS)));
            }
            let state = app.state::<HistoryState>();
            let due = state.2.load(Ordering::Acquire);
            if due == 0 {
                state.3.notified().await;
            } else {
                let delay =
                    std::time::Duration::from_millis(due.saturating_sub(now()).max(1) as u64);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = state.3.notified() => {},
                }
            }
        }
    });
}

async fn maintain_retention(app: tauri::AppHandle) -> Result<(), String> {
    if !app.state::<HistoryState>().cleanup_due(now()) {
        return Ok(());
    }
    worker(app, |app| {
        access(&app, &app.state::<HistoryState>(), |_| Ok(()))
    })
    .await
}

pub fn on_wake(app: tauri::AppHandle) {
    app.state::<HistoryState>().3.notify_one();
}

fn notify_removal(app: &tauri::AppHandle) {
    // No history content crosses the event boundary. Readers drop cached data
    // immediately, even if the subsequent refresh fails.
    let _ = app.emit("history-invalidated", ());
}
fn now() -> i64 {
    crate::now_epoch_ms() as i64
}
fn access<T>(
    app: &tauri::AppHandle,
    state: &HistoryState,
    work: impl FnOnce(&mut HistoryDb) -> crate::history_db::Result<T>,
) -> Result<T, String> {
    let _lock = state
        .0
        .lock()
        .map_err(|_| "History is temporarily unavailable".to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut db = HistoryDb::open(&dir).map_err(|e| {
        state.forget_audio_consent();
        state.2.store(-1, Ordering::Release);
        e.to_string()
    })?;
    state.cache_audio_consent(db.audio_consent().map_err(|e| e.to_string())?);
    let pruned = db.prune(now()).map_err(|e| e.to_string())?;
    let result = work(&mut db).map_err(|e| e.to_string());
    // Publish under the archive lock so older work cannot overwrite newer consent.
    state.cache_audio_consent(db.audio_consent().unwrap_or(None));
    if let Ok(due) = db.cleanup_due_at() {
        state.cache_cleanup_due_at(due);
    } else {
        // A scheduling read must not report an already committed mutation as a
        // failed write. Retry scheduling on the next access or native wake.
        state.2.store(-1, Ordering::Release);
        state.3.notify_one();
    }
    drop(db);
    drop(_lock);
    if pruned {
        notify_removal(app);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_consent_does_not_acquire_the_busy_archive_lock() {
        let state = HistoryState::default();
        assert_eq!(state.capture_consent(), None);
        let _busy_archive = state.0.lock().unwrap();
        state.cache_audio_consent(Some(7));
        assert_eq!(state.capture_consent(), Some(7));
        state.forget_audio_consent();
        assert_eq!(state.capture_consent(), None);
        state.cache_audio_consent(Some(9));
        assert_eq!(state.capture_consent(), Some(9));
    }

    #[test]
    fn cached_deadline_skips_work_until_due_and_indefinite_has_no_sweep() {
        let state = HistoryState::default();
        assert!(state.cleanup_due(100));
        state.cache_cleanup_due_at(None);
        assert!(!state.cleanup_due(i64::MAX));
        state.cache_cleanup_due_at(Some(1000));
        assert!(!state.cleanup_due(999));
        assert!(state.cleanup_due(1000));
    }
}
#[tauri::command]
pub async fn history_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.snapshot())
    })
    .await
}
#[tauri::command]
pub async fn history_query(
    app: tauri::AppHandle,
    query: String,
    offset: i64,
    limit: i64,
) -> Result<Value, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.query(&query, offset, limit))
    })
    .await
}
#[tauri::command]
pub async fn history_get(app: tauri::AppHandle, id: String) -> Result<Option<Value>, String> {
    worker(app, move |app| read_transcript(&app, &id)).await
}
/// For callers already running on a blocking worker, such as the tray menu.
pub(crate) fn read_transcript(app: &tauri::AppHandle, id: &str) -> Result<Option<Value>, String> {
    access(app, &app.state::<HistoryState>(), |db| db.get(id))
}
#[tauri::command]
pub async fn history_save(
    app: tauri::AppHandle,
    record: Value,
    recording_generation: Option<u64>,
) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        let recording = app.state::<crate::state::AppState>();
        access(&app, &state, |db| {
            let audio = {
                let mut rec = recording
                    .recording
                    .lock()
                    .map_err(|_| "Recording unavailable")?;
                recording_generation.and_then(|generation| rec.take_history_audio(generation))
            };
            match audio {
                Some(audio) => db.save_with_audio(&record, now(), Some(&audio)),
                None => db.save(&record, now()),
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn history_set_save_audio(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        let recording = app.state::<crate::state::AppState>();
        access(&app, &state, |db| {
            db.set_save_audio(enabled, now())?;
            if !enabled {
                let mut rec = recording
                    .recording
                    .lock()
                    .map_err(|_| "Recording unavailable")?;
                rec.history_audio = None;
                rec.audio_consent = None;
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn history_audio(
    app: tauri::AppHandle,
    id: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.audio_chunk(&id, offset, length))
            .map(tauri::ipc::Response::new)
    })
    .await
}

#[tauri::command]
pub async fn history_delete_audio(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| {
            db.delete_audio(id.as_deref())?;
            if id.is_none() {
                discard_pending_audio(&app);
            }
            Ok(())
        })?;
        notify_removal(&app);
        Ok(())
    })
    .await
}

fn discard_pending_audio(app: &tauri::AppHandle) {
    let state = app.state::<crate::state::AppState>();
    if let Ok(mut rec) = state.recording.lock() {
        rec.history_audio = None;
        rec.audio_consent = None;
    };
}

#[tauri::command(async)]
pub fn history_discard_pending_audio(
    state: State<'_, crate::state::AppState>,
    generation: u64,
) -> Result<(), String> {
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    rec.take_history_audio(generation);
    Ok(())
}

#[tauri::command]
pub async fn history_export_audio(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        // Keep the transcript ID in the filename so WAV exports can be paired with
        // the corresponding entry in a JSON history export for a local evaluation.
        let safe_id: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(100)
            .collect();
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Export dictation audio")
            .set_file_name(format!("Linty-{safe_id}.wav"))
            .add_filter("WAV audio", &["wav"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        validate_export_path(&app, &path)?;
        // Read after the dialog closes so deletion/retention wins while it is open.
        access(&app, &state, |db| {
            let parent = path.parent().ok_or("Choose an export folder")?;
            let temp = parent.join(format!(
                ".linty-audio-export-{}-{}.tmp",
                std::process::id(),
                now()
            ));
            let result = (|| -> crate::history_db::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)?;
                db.copy_audio(&id, &mut file)?;
                file.sync_all()?;
                std::fs::rename(&temp, &path)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result?;
            Ok(true)
        })
    })
    .await
}

fn validate_export_path(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .ok_or("Choose an export folder")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent.starts_with(data.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Choose an export location outside Linty's application data folder".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn history_patch(app: tauri::AppHandle, id: String, patch: Value) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.patch(&id, &patch))
    })
    .await
}
#[tauri::command]
pub async fn history_delete(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<DeletedTranscript>, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        let result = access(&app, &state, |db| db.delete(&id))?;
        if result.is_some() {
            notify_removal(&app);
        }
        Ok(result)
    })
    .await
}
#[tauri::command]
pub async fn history_restore(
    app: tauri::AppHandle,
    deleted: DeletedTranscript,
) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.restore(&deleted, now()))
    })
    .await
}
#[tauri::command]
pub async fn history_clear(app: tauri::AppHandle) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| {
            db.clear()?;
            discard_pending_audio(&app);
            Ok(())
        })?;
        notify_removal(&app);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn history_retention_preview(app: tauri::AppHandle, days: i64) -> Result<i64, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.retention_preview(days, now()))
    })
    .await
}
#[tauri::command]
pub async fn history_set_retention(app: tauri::AppHandle, days: i64) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.set_retention(days, now()))?;
        notify_removal(&app);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn history_usage_summary(
    app: tauri::AppHandle,
    start: i64,
    end: i64,
) -> Result<Value, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.usage_summary(start, end))
    })
    .await
}
#[tauri::command]
pub async fn history_usage(
    app: tauri::AppHandle,
    start: i64,
    end: i64,
    buckets: Vec<Bucket>,
) -> Result<Value, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        if buckets.len() > 2400 {
            return Err("The requested chart has too many intervals".into());
        }
        access(&app, &state, |db| db.usage(start, end, &buckets))
    })
    .await
}
#[tauri::command]
pub async fn history_corrections(app: tauri::AppHandle, id: String) -> Result<Vec<Value>, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.corrections(&id))
    })
    .await
}
#[tauri::command]
pub async fn history_add_correction(app: tauri::AppHandle, record: Value) -> Result<(), String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        access(&app, &state, |db| db.add_correction(&record))
    })
    .await
}
#[tauri::command]
pub async fn history_export(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    worker(app, move |app| {
        let state = app.state::<HistoryState>();
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Export transcription history")
            .set_file_name("Linty-history.json")
            .add_filter("JSON archive", &["json"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        validate_export_path(&app, &path)?;
        access(&app, &state, |db| {
            Ok(Some(
                serde_json::json!({"count":db.export(&path,now())?,"path":path.to_string_lossy()}),
            ))
        })
    })
    .await
}

/// Update only an existing dictation. Deletion/retention always wins over a late worker.
pub(crate) async fn update_pipeline(
    app: tauri::AppHandle,
    id: String,
    record: Value,
) -> Result<(), String> {
    worker(app, move |app| {
        access(&app, &app.state::<HistoryState>(), |db| {
            db.update_pipeline(&id, &record)
        })
    })
    .await
}
