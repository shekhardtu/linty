//! One owner for clipboard publication, paste injection and bounded observation.
use serde::Serialize;
use std::ops::Range;
use std::sync::Mutex;
use std::time::{Duration, Instant};
static DELIVERY: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub status: &'static str,
    pub command_posted: bool,
    pub command_posted_ms: Option<f64>,
    pub insertion_observed_ms: Option<f64>,
    pub reason: Option<String>,
}
/// Compare exact Unicode text around the captured UTF-16 selection. Substring
/// matching would misidentify text that was already elsewhere in the field.
fn inserted(before: &str, selection: Range<usize>, text: &str, after: &str) -> bool {
    fn byte(s: &str, offset: usize) -> Option<usize> {
        let mut units = 0;
        for (i, c) in s.char_indices() {
            if units == offset {
                return Some(i);
            }
            units += c.len_utf16();
        }
        (units == offset).then_some(s.len())
    }
    let Some((start, end)) = byte(before, selection.start).zip(byte(before, selection.end)) else {
        return false;
    };
    if start > end {
        return false;
    }
    after == format!("{}{}{}", &before[..start], text, &before[end..])
}
pub fn deliver(
    app: &tauri::AppHandle,
    text: &str,
    id: &str,
    observe: bool,
    check: impl Fn() -> Result<(), String>,
) -> Delivery {
    let started = Instant::now();
    let mut result = Delivery {
        status: "failed",
        command_posted: false,
        command_posted_ms: None,
        insertion_observed_ms: None,
        reason: None,
    };
    let work = (|| -> Result<(), String> {
        let _owner = DELIVERY.lock().map_err(|e| e.to_string())?;
        check()?;
        #[cfg(target_os = "macos")]
        {
            use crate::corrections::accessibility::Target;
            let pid = crate::corrections::accessibility::frontmost_pid(app);
            let target = Target::focused(app);
            let capture = crate::corrections::prepare_target(
                observe
                    .then(|| target.as_ref().map(Target::retained))
                    .flatten(),
            );
            check()?;
            crate::clipboard::cmd_snapshot()?;
            if let Err(error) = crate::clipboard::cmd_write_transient(text) {
                let _ = crate::clipboard::cmd_restore();
                crate::corrections::complete_paste(capture, None);
                return Err(error);
            }
            let posted = crate::paste::simulate_paste_checked(app, &|| {
                check()?;
                if pid.is_none()
                    || crate::corrections::accessibility::frontmost_pid(app) != pid
                    || target
                        .as_ref()
                        .is_some_and(|t| t.is_focused() != Some(true))
                {
                    return Err("The destination changed before pasting".into());
                }
                Ok(())
            });
            if let Err(error) = posted {
                let _ = crate::clipboard::cmd_restore();
                crate::corrections::complete_paste(capture, None);
                return Err(error);
            }
            result.command_posted = true;
            result.command_posted_ms = Some(started.elapsed().as_secs_f64() * 1000.);
            result.status = "unverified";
            let posted_at = Instant::now();
            crate::corrections::complete_paste(capture, observe.then(|| (id.into(), text.into())));
            if let Some(target) = target {
                while posted_at.elapsed() < Duration::from_secs(2) {
                    if check().is_err() {
                        result.reason = Some("cancelled_after_post".into());
                        break;
                    }
                    if target.is_focused() != Some(true) || target.is_composing() {
                        result.reason = Some("destination_changed".into());
                        break;
                    }
                    if target.read().is_some_and(|after| {
                        inserted(&target.before, target.selection.clone(), text, &after)
                    }) {
                        result.status = "verified";
                        result.insertion_observed_ms =
                            Some(started.elapsed().as_secs_f64() * 1000.);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }
                if result.status == "unverified" && result.reason.is_none() {
                    result.reason = Some("insertion_not_observed".into());
                }
            } else {
                result.reason = Some("destination_not_readable".into());
            }
            // Even verified targets may perform subsequent clipboard reads. A
            // read by an unrelated clipboard manager never triggers restoration.
            let remaining = crate::clipboard::RESTORE_DELAY_MS
                .saturating_sub(posted_at.elapsed().as_millis() as u64);
            crate::clipboard::schedule_restore(remaining);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, text, id, observe, started);
            Err("Native delivery requires macOS".into())
        }
    })();
    if let Err(error) = work {
        result.reason = Some(error);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_exact_selection_and_unicode() {
        assert!(inserted("Hi 😀 Sara", 3..5, "Maya", "Hi Maya Sara"));
        assert!(!inserted(
            "hello hello",
            0..5,
            "hello",
            "hello hello elsewhere"
        ));
        assert!(!inserted("", 0..0, "Don't send it.", "Send it."));
        assert!(!inserted("😀", 1..2, "x", "x"));
        assert!(inserted("abc", 1..2, "🌱", "a🌱c"));
    }
}
