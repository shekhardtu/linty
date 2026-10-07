//! Login-item registration belongs to macOS; the store records only whether
//! the one-time default has been applied or a customer has made a choice.
use objc2_foundation::{NSAppleEventManager, NSBundle};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use std::{path::Path, sync::Mutex};
use tauri::{Manager, Runtime};
use tauri_plugin_store::{Store, StoreExt};

const STORE: &str = "linty-settings.json";
const INITIALIZED: &str = "launchAtLoginInitialized";

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Enabled,
    Disabled,
    RequiresApproval,
    Unavailable,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    status: Status,
    initialized: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct StartupState(Mutex<Option<String>>);

trait LoginItem {
    fn status(&self) -> Status;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
}

struct MacLoginItem;

impl LoginItem for MacLoginItem {
    fn status(&self) -> Status {
        if !installed() {
            return Status::Unavailable;
        }
        // SAFETY: macOS 14 is our minimum, so SMAppService is available. The
        // retained service handle is created, used and dropped on this thread.
        match unsafe { SMAppService::mainAppService().status() } {
            SMAppServiceStatus::Enabled => Status::Enabled,
            // Before the first registration, a newly replaced app can have no
            // service record yet. It is off, and register() creates that record.
            SMAppServiceStatus::NotRegistered | SMAppServiceStatus::NotFound => Status::Disabled,
            SMAppServiceStatus::RequiresApproval => Status::RequiresApproval,
            _ => Status::Unavailable,
        }
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let status = self.status();
        if status == Status::Unavailable {
            return Err("Install Linty in Applications to change launch at login.".into());
        }
        // Never unregister/reregister a denied service to bypass macOS consent.
        if enabled && matches!(status, Status::Enabled | Status::RequiresApproval)
            || !enabled && status == Status::Disabled
        {
            return Ok(());
        }
        // SAFETY: installed() checked the application bundle; macOS 14+ provides
        // this main-app service. No ObjC handle is shared across threads.
        let service = unsafe { SMAppService::mainAppService() };
        let result = if enabled {
            unsafe { service.registerAndReturnError() }
        } else {
            unsafe { service.unregisterAndReturnError() }
        };
        // A denied registration can still have registered successfully. Surface
        // requiresApproval honestly instead of treating it as enabled or retrying.
        if enabled && self.status() == Status::RequiresApproval {
            return Ok(());
        }
        result.map_err(|error| format!("Could not change launch at login: {error}"))
    }
}

fn installed_path(path: &Path, home: Option<&Path>) -> bool {
    path.extension().is_some_and(|extension| extension == "app")
        && (path.starts_with("/Applications")
            || home.is_some_and(|home| path.starts_with(home.join("Applications"))))
}

fn installed() -> bool {
    // Build candidates, mounted DMGs, App Translocation and dev binaries must
    // never become persistent login items for the customer's installed app.
    if cfg!(debug_assertions) {
        return false;
    }
    let bundle = NSBundle::mainBundle();
    let path = bundle.bundlePath().to_string();
    let Ok(path) = Path::new(&path).canonicalize() else {
        return false;
    };
    let home = std::env::var_os("HOME");
    installed_path(&path, home.as_deref().map(Path::new))
        && bundle
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == "ai.linty.desktop")
}

fn initialized<R: Runtime>(store: &Store<R>) -> bool {
    store.get(INITIALIZED) == Some(serde_json::json!(true))
}

fn mark_initialized<R: Runtime>(store: &Store<R>) -> Result<(), String> {
    let previous = store.get(INITIALIZED);
    store.set(INITIALIZED, serde_json::json!(true));
    if let Err(error) = store.save() {
        if let Some(previous) = previous {
            store.set(INITIALIZED, previous);
        } else {
            store.delete(INITIALIZED);
        }
        return Err(format!(
            "Could not save launch-at-login preference: {error}"
        ));
    }
    Ok(())
}

fn migrate<R: Runtime>(store: &Store<R>, item: &impl LoginItem) -> Result<(), String> {
    if initialized(store)
        || store.get("onboardingComplete") != Some(serde_json::json!(true))
        || item.status() == Status::Unavailable
    {
        return Ok(());
    }
    item.set_enabled(true)?;
    mark_initialized(store)
}

fn choose<R: Runtime>(
    store: &Store<R>,
    item: &impl LoginItem,
    enabled: bool,
) -> Result<(), String> {
    if item.status() == Status::Unavailable {
        return Err("Install Linty in Applications to change launch at login.".into());
    }
    // Save the explicit choice before changing macOS. A failed registration
    // must not make a later launch mistake an explicit opt-out for an upgrade.
    mark_initialized(store)?;
    item.set_enabled(enabled)
}

pub fn initialize(app: &tauri::AppHandle) {
    log::debug!(
        "[startup] installed={} status={:?}",
        installed(),
        MacLoginItem.status()
    );
    let state = app.state::<StartupState>();
    let mut error = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let result = app
        .store(STORE)
        .map_err(|e| e.to_string())
        .and_then(|store| migrate(&store, &MacLoginItem));
    if let Err(message) = result {
        log::warn!("[startup] {message}");
        *error = Some(message);
    }
}

fn snapshot(app: &tauri::AppHandle, error: Option<String>) -> Result<Snapshot, String> {
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    Ok(Snapshot {
        status: MacLoginItem.status(),
        initialized: initialized(&store),
        error,
    })
}

#[tauri::command]
pub fn get_startup_settings(app: tauri::AppHandle) -> Result<Snapshot, String> {
    let state = app.state::<StartupState>();
    let error = state.0.lock().map_err(|e| e.to_string())?;
    snapshot(&app, error.clone())
}

#[tauri::command]
pub fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<Snapshot, String> {
    let state = app.state::<StartupState>();
    let mut error = state.0.lock().map_err(|e| e.to_string())?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    match choose(&store, &MacLoginItem, enabled) {
        Ok(()) => *error = None,
        Err(message) => {
            *error = Some(message.clone());
            return Err(message);
        }
    }
    snapshot(&app, None)
}

#[tauri::command]
pub fn finish_startup_setup(app: tauri::AppHandle, enabled: bool) -> Result<Snapshot, String> {
    let state = app.state::<StartupState>();
    let mut error = state.0.lock().map_err(|e| e.to_string())?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    // Permission recovery must not overwrite a past choice. Fresh setup can
    // retry after its completion save fails and change the draft before retrying.
    if store.get("onboardingComplete") != Some(serde_json::json!(true))
        && MacLoginItem.status() != Status::Unavailable
    {
        *error = choose(&store, &MacLoginItem, enabled).err();
        if let Some(message) = &*error {
            log::warn!("[startup] {message}");
        }
    }
    snapshot(&app, error.clone())
}

#[tauri::command]
pub fn open_login_items_settings(app: tauri::AppHandle) -> Result<(), String> {
    // SAFETY: the supported OS provides this class method, and opening system
    // UI is dispatched to AppKit's main thread.
    app.run_on_main_thread(|| unsafe { SMAppService::openSystemSettingsLoginItems() })
        .map_err(|e| e.to_string())
}

/// Tauri setup runs inside Tao's applicationDidFinishLaunching callback. The
/// current Apple event exists only there; capture it before showing any window.
pub fn launched_at_login() -> bool {
    let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else {
        return false;
    };
    is_login_event(&event)
}

fn is_login_event(event: &objc2_foundation::NSAppleEventDescriptor) -> bool {
    // Carbon four-character codes: kAEOpenApplication, keyAEPropData,
    // keyAELaunchedAsLogInItem. Avoid adding the entire CoreServices framework.
    // SAFETY: setup is on AppKit's main thread. These are documented selectors
    // on retained NSAppleEventDescriptors with Carbon's u32 four-character codes.
    unsafe {
        let event_id: u32 = objc2::msg_send![event, eventID];
        let reason: Option<objc2::rc::Retained<objc2_foundation::NSAppleEventDescriptor>> =
            objc2::msg_send![event, paramDescriptorForKeyword: u32::from_be_bytes(*b"prdt")];
        event_id == u32::from_be_bytes(*b"oapp")
            && reason.is_some_and(|reason| {
                let code: u32 = objc2::msg_send![&*reason, enumCodeValue];
                code == u32::from_be_bytes(*b"lgit")
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn native_apple_event_identifies_login_but_not_ordinary_open_or_reopen() {
        use objc2::{class, msg_send, rc::Retained};
        use objc2_foundation::NSAppleEventDescriptor;
        for (id, reason, expected) in [
            (*b"oapp", Some(*b"lgit"), true),
            (*b"oapp", None, false),
            (*b"oapp", Some(*b"atlg"), false),
            (*b"rapp", Some(*b"lgit"), false),
        ] {
            // SAFETY: these documented Foundation constructors create retained
            // test descriptors; no application is launched and no UI is changed.
            let event: Retained<NSAppleEventDescriptor> = unsafe {
                msg_send![
                    class!(NSAppleEventDescriptor),
                    appleEventWithEventClass: u32::from_be_bytes(*b"aevt"),
                    eventID: u32::from_be_bytes(id),
                    targetDescriptor: std::ptr::null::<objc2::runtime::AnyObject>(),
                    returnID: -1i16,
                    transactionID: 0i32
                ]
            };
            if let Some(reason) = reason {
                unsafe {
                    let reason: Retained<NSAppleEventDescriptor> = msg_send![
                        class!(NSAppleEventDescriptor), descriptorWithEnumCode: u32::from_be_bytes(reason)
                    ];
                    let _: () = msg_send![&*event, setParamDescriptor: &*reason, forKeyword: u32::from_be_bytes(*b"prdt")];
                }
            }
            assert_eq!(is_login_event(&event), expected);
        }
    }

    struct Item {
        status: Cell<Status>,
        calls: RefCell<Vec<bool>>,
        fail: Cell<bool>,
    }
    impl LoginItem for Item {
        fn status(&self) -> Status {
            self.status.get()
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            self.calls.borrow_mut().push(enabled);
            if self.fail.get() {
                return Err("synthetic registration failure".into());
            }
            if self.status.get() != Status::RequiresApproval {
                self.status.set(if enabled {
                    Status::Enabled
                } else {
                    Status::Disabled
                });
            }
            Ok(())
        }
    }
    fn item(status: Status) -> Item {
        Item {
            status: Cell::new(status),
            calls: RefCell::default(),
            fail: Cell::new(false),
        }
    }

    #[test]
    fn upgrade_applies_default_once_and_opt_out_survives_relaunch() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = app.store(dir.path().join("settings.json")).unwrap();
        store.set("onboardingComplete", serde_json::json!(true));
        let item = item(Status::Disabled);
        migrate(&store, &item).unwrap();
        assert_eq!(item.status(), Status::Enabled);
        store.reload_ignore_defaults().unwrap();
        assert!(initialized(&store));
        choose(&store, &item, false).unwrap();
        store.reload_ignore_defaults().unwrap();
        migrate(&store, &item).unwrap();
        assert_eq!(item.status(), Status::Disabled);
        assert_eq!(*item.calls.borrow(), vec![true, false]);
    }

    #[test]
    fn fresh_setup_unavailable_builds_and_failed_upgrades_do_not_complete_migration() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = app.store(dir.path().join("settings.json")).unwrap();
        let item = item(Status::Disabled);
        migrate(&store, &item).unwrap();
        assert!(!initialized(&store));
        assert!(item.calls.borrow().is_empty());
        store.set("onboardingComplete", serde_json::json!(true));
        item.status.set(Status::Unavailable);
        store.save().unwrap();
        migrate(&store, &item).unwrap();
        assert!(!initialized(&store));
        item.status.set(Status::Disabled);
        item.fail.set(true);
        assert!(migrate(&store, &item).is_err());
        store.reload_ignore_defaults().unwrap();
        assert!(!initialized(&store));
        // Save the synthetic upgrade state again after reloading disk.
        store.set("onboardingComplete", serde_json::json!(true));
        item.fail.set(false);
        migrate(&store, &item).unwrap();
        assert!(initialized(&store));
    }

    #[test]
    fn explicit_choice_is_recorded_even_if_the_system_operation_fails() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = app.store(dir.path().join("settings.json")).unwrap();
        store.set("onboardingComplete", serde_json::json!(true));
        let item = item(Status::Enabled);
        item.fail.set(true);
        assert!(choose(&store, &item, false).is_err());
        store.reload_ignore_defaults().unwrap();
        assert!(initialized(&store));
        item.fail.set(false);
        item.status.set(Status::Disabled); // Customer changed macOS Settings.
        migrate(&store, &item).unwrap();
        assert_eq!(*item.calls.borrow(), vec![false]);
    }

    #[test]
    fn blocked_service_stays_pending_and_the_marker_survives_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = app.store(dir.path().join("settings.json")).unwrap();
        store.set("onboardingComplete", serde_json::json!(true));
        let item = item(Status::RequiresApproval);
        migrate(&store, &item).unwrap();
        assert_eq!(item.status(), Status::RequiresApproval);
        item.status.set(Status::Disabled);
        migrate(&store, &item).unwrap();
        assert_eq!(*item.calls.borrow(), vec![true]);
    }

    #[test]
    fn only_installed_app_paths_are_eligible() {
        let home = Some(Path::new("/Users/test"));
        assert!(installed_path(Path::new("/Applications/Linty.app"), home));
        assert!(installed_path(
            Path::new("/Users/test/Applications/Linty.app"),
            home
        ));
        for path in [
            "/ApplicationsFake/Linty.app",
            "/Volumes/Linty/Linty.app",
            "/tmp/build/Linty.app",
            "/Applications/linty",
            "/Users/test/Downloads/Linty.app",
        ] {
            assert!(!installed_path(Path::new(path), home), "{path}");
        }
    }
}
