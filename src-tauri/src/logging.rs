//! Local-only diagnostics: a rotating log file and a panic hook.
//!
//! Nothing here leaves the Mac. Logs are written to
//! `~/Library/Logs/ai.linty.desktop/linty.log` (plus stderr, which only a
//! terminal launch shows) and are shared only if the user exports them.
//!
//! Redaction rule for every `log::` call in this crate: never log transcript
//! text, clipboard contents, API keys or dictionary words. Log counts, lengths,
//! durations, engine and model names instead. Error strings from other code
//! must be checked too: some quote the data they failed on.
//!
//! The formatter replaces the home folder with `~` in every line, whatever its
//! source, so the macOS username is not recorded.

use std::borrow::Cow;
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use log::LevelFilter;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use time::format_description::FormatItem;
use time::macros::format_description;

/// Active log file is `linty.log`; rotated files are `linty_<date>.log`.
const LOG_FILE_NAME: &str = "linty";
/// Rotate once the active file would grow past this size.
const MAX_LOG_FILE_BYTES: u128 = 5 * 1024 * 1024;
/// Rotated files kept next to the active one: five files, 25 MB at most.
const ARCHIVED_LOG_FILES: usize = 4;

/// Written to the app data directory when a panic occurs. The diagnostics
/// export reads it; `reset_all_data` deletes it.
pub const CRASH_MARKER: &str = "crash.marker";

/// Earlier builds wrote fn-key diagnostics straight into the home folder.
const LEGACY_FNKEY_LOG: &str = "linty-fnkey.log";

/// Third-party crates whose info-level output is noise for support purposes.
const QUIET_CRATES: [&str; 6] = ["tao", "wry", "reqwest", "hyper", "hyper_util", "rustls"];

/// Same shape as the plugin's default: `[2026-09-16][18:34:36]`, in UTC.
const TIMESTAMP: &[FormatItem<'static>] =
    format_description!("[[[year]-[month]-[day]][[[hour]:[minute]:[second]]");

static CRASH_MARKER_PATH: OnceLock<PathBuf> = OnceLock::new();
static APP_VERSION: OnceLock<String> = OnceLock::new();
thread_local! {
    /// Set while this thread is inside the panic hook, so a panic raised while
    /// logging a panic does not recurse. Other threads still get logged.
    static IN_PANIC_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// The logging plugin. Register it first so every later plugin and the setup
/// hook can log.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let home = std::env::var("HOME").ok().filter(|home| !home.is_empty());
    let mut builder = tauri_plugin_log::Builder::new()
        .format(move |out, message, record| {
            let line = message.to_string();
            let line = match home.as_deref() {
                Some(home) => redact_home(&line, home),
                None => Cow::Borrowed(line.as_str()),
            };
            let now = time::OffsetDateTime::now_utc()
                .format(TIMESTAMP)
                .unwrap_or_default();
            out.finish(format_args!(
                "{}[{}][{}] {}",
                now,
                record.target(),
                record.level(),
                line
            ))
        })
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stderr),
            Target::new(TargetKind::LogDir {
                file_name: Some(LOG_FILE_NAME.into()),
            }),
        ])
        .level(level)
        .max_file_size(MAX_LOG_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(ARCHIVED_LOG_FILES));
    for name in QUIET_CRATES {
        builder = builder.level_for(name, LevelFilter::Warn);
    }
    builder.build()
}

/// Called once from the setup hook, after the logging plugin is live.
pub fn init<R: Runtime>(app: &tauri::AppHandle<R>) {
    let version = app.package_info().version.to_string();
    let _ = APP_VERSION.set(version.clone());

    log::info!(
        "[app] Linty {} starting (macOS {}, {}, {} build)",
        version,
        macos_version().as_deref().unwrap_or("unknown"),
        std::env::consts::ARCH,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    );

    match app.path().app_data_dir() {
        Ok(dir) => {
            let marker = dir.join(CRASH_MARKER);
            report_previous_crash(&marker);
            let _ = CRASH_MARKER_PATH.set(marker);
        }
        Err(e) => log::warn!("[app] No app data dir, crash marker disabled: {}", e),
    }

    install_panic_hook();
    remove_legacy_fnkey_log(app);
}

/// Replace every occurrence of `home` that ends at a path boundary with `~`.
/// `/Users/alice/x` becomes `~/x`; `/Users/alicebob` is left alone.
fn redact_home<'a>(text: &'a str, home: &str) -> Cow<'a, str> {
    let home = home.trim_end_matches('/');
    if home.is_empty() || !text.contains(home) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(home) {
        let after = &rest[at + home.len()..];
        let continues_name = after
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'));
        out.push_str(&rest[..at]);
        out.push_str(if continues_name { home } else { "~" });
        rest = after;
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !IN_PANIC_HOOK.with(|busy| busy.replace(true)) {
            let thread = std::thread::current();
            let thread_name = thread.name().unwrap_or("unnamed").to_string();
            let location = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_else(|| "unknown location".to_string());
            let message = panic_message(info.payload());
            let backtrace = std::backtrace::Backtrace::force_capture();

            log::error!(
                "[panic] thread '{}' panicked at {}: {}\n{}",
                thread_name,
                location,
                message,
                backtrace
            );
            log::logger().flush();
            write_crash_marker(&thread_name, &location);
            IN_PANIC_HOOK.with(|busy| busy.set(false));
        }
        default_hook(info);
    }));
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

fn write_crash_marker(thread_name: &str, location: &str) {
    let Some(path) = CRASH_MARKER_PATH.get() else {
        return;
    };
    let unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let contents = crash_marker_contents(
        unix_secs,
        APP_VERSION.get().map(String::as_str).unwrap_or("unknown"),
        thread_name,
        location,
    );
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, contents) {
        log::error!("[panic] Could not write crash marker: {}", e);
    }
}

fn crash_marker_contents(
    unix_secs: u64,
    version: &str,
    thread_name: &str,
    location: &str,
) -> String {
    format!(
        "time={}\nversion={}\nthread={}\nlocation={}\n",
        unix_secs, version, thread_name, location
    )
}

/// The marker stays until the user exports diagnostics or resets data, so a
/// crash is noted at every launch until someone has looked at it.
fn report_previous_crash(marker: &Path) {
    if let Ok(contents) = std::fs::read_to_string(marker) {
        log::warn!(
            "[app] A previous session crashed ({})",
            contents.trim().replace('\n', ", ")
        );
    }
}

fn remove_legacy_fnkey_log<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let legacy = home.join(LEGACY_FNKEY_LOG);
    if legacy.is_file() {
        match std::fs::remove_file(&legacy) {
            Ok(()) => log::info!("[app] Removed legacy {}", legacy.display()),
            Err(e) => log::warn!("[app] Could not remove legacy {}: {}", legacy.display(), e),
        }
    }
}

/// Reads the product version from the system version plist, which every
/// process can read, so startup never spawns `sw_vers`.
fn macos_version() -> Option<String> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    product_version(&plist)
}

fn product_version(plist: &str) -> Option<String> {
    let after_key = plist.split("<key>ProductVersion</key>").nth(1)?;
    let value = after_key
        .split("<string>")
        .nth(1)?
        .split("</string>")
        .next()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_home_replaces_every_home_path() {
        assert_eq!(
            redact_home(
                "Loading model from: /Users/alice/Library/Application Support/ai.linty.desktop/models/x.bin",
                "/Users/alice"
            ),
            "Loading model from: ~/Library/Application Support/ai.linty.desktop/models/x.bin"
        );
        assert_eq!(
            redact_home(
                "modelNotFound(file:///Users/alice/Library/x) and \"/Users/alice\"",
                "/Users/alice/"
            ),
            "modelNotFound(file://~/Library/x) and \"~\""
        );
        assert_eq!(redact_home("/Users/alice", "/Users/alice"), "~");
    }

    #[test]
    fn redact_home_leaves_other_paths_alone() {
        assert!(matches!(
            redact_home("/tmp/x", "/Users/alice"),
            Cow::Borrowed("/tmp/x")
        ));
        assert_eq!(
            redact_home("/Users/alicebob/x", "/Users/alice"),
            "/Users/alicebob/x"
        );
        assert_eq!(
            redact_home("/Users/alice.old/x", "/Users/alice"),
            "/Users/alice.old/x"
        );
        assert_eq!(redact_home("/Users/alice/x", ""), "/Users/alice/x");
    }

    #[test]
    fn panic_message_reads_both_string_payloads() {
        let borrowed: Box<dyn std::any::Any + Send> = Box::new("index out of bounds");
        let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("lock poisoned"));
        let other: Box<dyn std::any::Any + Send> = Box::new(42_u8);
        assert_eq!(panic_message(borrowed.as_ref()), "index out of bounds");
        assert_eq!(panic_message(owned.as_ref()), "lock poisoned");
        assert_eq!(panic_message(other.as_ref()), "non-string panic payload");
    }

    #[test]
    fn crash_marker_is_one_field_per_line() {
        assert_eq!(
            crash_marker_contents(1_758_000_000, "0.0.38", "main", "src/lib.rs:10"),
            "time=1758000000\nversion=0.0.38\nthread=main\nlocation=src/lib.rs:10\n"
        );
    }

    #[test]
    fn panic_hook_writes_the_crash_marker() {
        let dir = std::env::temp_dir().join(format!("linty-panic-hook-{}", std::process::id()));
        let marker = dir.join(CRASH_MARKER);
        CRASH_MARKER_PATH
            .set(marker.clone())
            .expect("only this test sets the marker path");
        install_panic_hook();

        let joined = std::thread::Builder::new()
            .name("panic-probe".into())
            .spawn(|| panic!("probe"))
            .unwrap()
            .join();
        assert!(joined.is_err());

        let contents = std::fs::read_to_string(&marker).expect("marker written");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(contents.contains("thread=panic-probe\n"), "{contents}");
        assert!(contents.contains("location=src/logging.rs:"), "{contents}");
        assert!(contents.starts_with("time="), "{contents}");
    }

    #[test]
    fn product_version_parses_the_system_plist() {
        let plist = "<dict>\n\t<key>BuildID</key>\n\t<string>X</string>\n\t<key>ProductVersion</key>\n\t<string>26.0.1</string>\n</dict>";
        assert_eq!(product_version(plist).as_deref(), Some("26.0.1"));
        assert_eq!(product_version("<dict></dict>"), None);
        assert_eq!(
            product_version("<key>ProductVersion</key><string> </string>"),
            None
        );
    }
}
