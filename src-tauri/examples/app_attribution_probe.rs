#[path = "../src/application.rs"]
mod application;
#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[cfg(target_os = "macos")]
fn main() {
    let app = application::frontmost_application()
        .expect("An active application should be available in this macOS session");
    assert!(!app.name.trim().is_empty());
    let json = serde_json::to_value(&app).expect("Application identity serializes");
    assert!(json.get("name").is_some());
    assert!(json.get("bundleId").is_some());
    println!(
        "Native foreground application lookup and IPC serialization passed (identity not logged)."
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {
    assert!(application::frontmost_application().is_none());
    println!("Application attribution is only available on macOS.");
}
