//! Runs the real logging plugin and startup hook on Tauri's mock runtime with
//! HOME pointed at a temporary folder, so nothing touches the user's Library.
//! Kept as the only test in this binary: it sets HOME and the global logger.

use std::fs;
use std::path::PathBuf;

use linty_lib::logging;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;

const IDENTIFIER: &str = "ai.linty.logging-smoke";

#[test]
fn plugin_writes_the_log_file_and_startup_hook_tidies_up() {
    let home = std::env::temp_dir().join(format!("linty-logging-smoke-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    let data_dir = home.join("Library/Application Support").join(IDENTIFIER);
    let log_file: PathBuf = home.join("Library/Logs").join(IDENTIFIER).join("linty.log");
    let legacy = home.join("linty-fnkey.log");

    fs::create_dir_all(&data_dir).unwrap();
    fs::write(
        data_dir.join(logging::CRASH_MARKER),
        "time=1\nversion=0.0.1\nthread=main\nlocation=src/x.rs:1\n",
    )
    .unwrap();
    fs::write(&legacy, "[fnkey] old line\n").unwrap();

    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = IDENTIFIER.to_string();
    // Plugins initialize during build(); the real app's setup hook runs later,
    // on the event loop's Ready event, which the mock runtime never sends.
    let app = mock_builder()
        .plugin(logging::plugin())
        .build(context)
        .expect("mock app builds");
    logging::init(app.handle());

    assert_eq!(
        app.path().app_log_dir().unwrap(),
        log_file.parent().unwrap()
    );
    log::info!("[test] after startup {}", data_dir.display());
    log::warn!(
        "[test] bridge error: file://{}/model.mlmodelc",
        data_dir.display()
    );
    log::debug!("[test] debug lines are kept in debug builds");
    log::logger().flush();

    let written = fs::read_to_string(&log_file).expect("log file exists");
    let _ = fs::remove_dir_all(&home);

    assert!(
        written.contains("[app] Linty 0.1.0 starting (macOS "),
        "{written}"
    );
    assert!(
        written.contains("[app] A previous session crashed (time=1, version=0.0.1, thread=main, location=src/x.rs:1)"),
        "{written}"
    );
    assert!(
        written.contains("[app] Removed legacy ~/linty-fnkey.log"),
        "{written}"
    );
    assert!(
        written
            .contains("[test] after startup ~/Library/Application Support/ai.linty.logging-smoke"),
        "{written}"
    );
    assert!(
        written.contains("[test] bridge error: file://~/Library/Application Support/ai.linty.logging-smoke/model.mlmodelc"),
        "{written}"
    );
    assert!(written.contains("[DEBUG]"), "{written}");
    assert!(
        !written.contains(&*home.to_string_lossy()),
        "home folder leaked into the log:\n{written}"
    );
    assert!(!legacy.exists());
}
