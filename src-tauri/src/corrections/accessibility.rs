//! Bounded, read-only macOS adapter. AX reads stay off the main thread;
//! callbacks only mark activity. No key characters or field contents are logged.
use super::session::InputState;
use std::ffi::{c_void, CStr};
use std::ops::Range;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use cocoa::{
    base::{id, nil},
    foundation::NSString,
};
use objc::{class, msg_send, sel, sel_impl};

const MAX_UTF16: i64 = 20_000;
#[repr(C)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
    fn AXUIElementCopyAttributeValue(
        e: *const c_void,
        key: *const c_void,
        out: *mut *const c_void,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        e: *const c_void,
        key: *const c_void,
        param: *const c_void,
        out: *mut *const c_void,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeNames(e: *const c_void, out: *mut *const c_void)
        -> i32;
    fn AXUIElementSetMessagingTimeout(e: *const c_void, timeout: f32) -> i32;
    fn AXUIElementGetPid(e: *const c_void, pid: *mut i32) -> i32;
    fn AXValueCreate(kind: u32, value: *const c_void) -> *const c_void;
    fn AXValueGetValue(value: *const c_void, kind: u32, out: *mut c_void) -> bool;
    fn AXValueGetTypeID() -> usize;
    fn AXObserverCreate(
        pid: i32,
        callback: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void, *mut c_void),
        out: *mut *const c_void,
    ) -> i32;
    fn AXObserverAddNotification(
        observer: *const c_void,
        element: *const c_void,
        name: *const c_void,
        context: *mut c_void,
    ) -> i32;
    fn AXObserverGetRunLoopSource(observer: *const c_void) -> *const c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFRelease(cf: *const c_void);
    fn CFGetTypeID(cf: *const c_void) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: *const c_void) -> bool;
    fn CFNumberGetValue(cf: *const c_void, kind: i64, out: *mut c_void) -> bool;
    fn CFEqual(a: *const c_void, b: *const c_void) -> bool;
    fn CFRunLoopGetCurrent() -> *const c_void;
    fn CFRunLoopAddSource(run_loop: *const c_void, source: *const c_void, mode: *const c_void);
    fn CFRunLoopRemoveSource(run_loop: *const c_void, source: *const c_void, mode: *const c_void);
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: bool) -> i32;
    static kCFRunLoopDefaultMode: *const c_void;
}

struct Cf(*const c_void);
impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
// AXUIElement's retained proxy can be transferred to the worker. It is never
// accessed concurrently. Observer and run-loop objects are never transferred.
unsafe impl Send for Target {}

fn pool<T>(work: impl FnOnce() -> T) -> T {
    unsafe {
        let pool: id = msg_send![class!(NSAutoreleasePool), new];
        let result = work();
        let _: () = msg_send![pool, drain];
        result
    }
}
unsafe fn named<T>(name: &str, work: impl FnOnce(*const c_void) -> T) -> T {
    let key = NSString::alloc(nil).init_str(name);
    let result = work(key as *const c_void);
    let _: () = msg_send![key, release];
    result
}
unsafe fn attr(e: *const c_void, name: &str) -> Option<Cf> {
    named(name, |key| {
        let mut out = std::ptr::null();
        let error = AXUIElementCopyAttributeValue(e, key, &mut out);
        (error == 0 && !out.is_null()).then_some(Cf(out))
    })
}
unsafe fn string(value: &Cf) -> Option<String> {
    if CFGetTypeID(value.0) != CFStringGetTypeID() {
        return None;
    }
    let bytes: *const std::os::raw::c_char = msg_send![value.0 as id, UTF8String];
    (!bytes.is_null()).then(|| CStr::from_ptr(bytes).to_string_lossy().into_owned())
}
unsafe fn text_attr(e: *const c_void, key: &str) -> Option<String> {
    attr(e, key).and_then(|value| string(&value))
}

#[derive(Clone, Copy)]
enum TextCapability {
    Range,
    Value,
}

pub(crate) fn frontmost_pid(app: &tauri::AppHandle) -> Option<i32> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let pid = pool(|| unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: id = msg_send![workspace, frontmostApplication];
            if front.is_null() {
                None
            } else {
                Some(msg_send![front, processIdentifier])
            }
        });
        let _ = send.send(pid);
    })
    .ok()?;
    receive.recv_timeout(Duration::from_secs(1)).ok()?
}

pub struct Target {
    capability: TextCapability,
    pub before: String,
    pub selection: Range<usize>,
    element: Cf,
    pub pid: i32,
    pub application: super::ObservedApplication,
}
impl Target {
    pub fn is_composing(&self) -> bool {
        pool(|| unsafe {
            let Some(value) = attr(self.element.0, "AXMarkedTextRange") else {
                return false;
            };
            let mut range = CFRange {
                location: 0,
                length: 0,
            };
            CFGetTypeID(value.0) == AXValueGetTypeID()
                && AXValueGetValue(value.0, 4, &mut range as *mut _ as *mut c_void)
                && range.length > 0
        })
    }
    /// Called before Cmd+V, so delayed reads cannot attach to another field.
    pub fn focused(app: &tauri::AppHandle) -> Option<Self> {
        Self::for_pid(frontmost_pid(app)?)
    }
    fn for_pid(pid: i32) -> Option<Self> {
        pool(|| unsafe {
            let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if app.is_null() {
                return None;
            }
            let application = Cf(AXUIElementCreateApplication(pid));
            AXUIElementSetMessagingTimeout(application.0, 0.15);
            if bool_attr(application.0, "AXFrontmost") != Some(true) {
                return None;
            }
            let element = attr(application.0, "AXFocusedUIElement")?;
            AXUIElementSetMessagingTimeout(element.0, 0.15);
            let mut element_pid = 0;
            if AXUIElementGetPid(element.0, &mut element_pid) != 0 || element_pid != pid {
                return None;
            }
            if text_attr(element.0, "AXSubrole").as_deref() == Some("AXSecureTextField") {
                return None;
            }
            let name: id = msg_send![app, localizedName];
            let bundle: id = msg_send![app, bundleIdentifier];
            let from_ns = |s: id| -> Option<String> {
                if s.is_null() {
                    return None;
                }
                let bytes: *const std::os::raw::c_char = msg_send![s, UTF8String];
                (!bytes.is_null()).then(|| CStr::from_ptr(bytes).to_string_lossy().into_owned())
            };
            let bundle_id = from_ns(bundle);
            if bundle_id.as_deref() == Some("ai.linty.desktop") {
                return None;
            }
            let role = text_attr(element.0, "AXRole");
            if !matches!(
                role.as_deref(),
                Some("AXTextArea" | "AXTextField" | "AXComboBox")
            ) {
                log::info!("[corrections] capture unavailable: focused element is not an editable text control");
                return None;
            }
            let Some(capability) = capability(element.0) else {
                log::info!("[corrections] capture unavailable: no supported text capability");
                return None;
            };
            let Some(selection) = text_range(element.0, "AXSelectedTextRange") else {
                log::info!("[corrections] capture unavailable: no insertion selection");
                return None;
            };
            let mut target = Self {
                element,
                pid,
                capability,
                before: String::new(),
                selection,
                application: super::ObservedApplication {
                    name: from_ns(name).unwrap_or_else(|| "Application".into()),
                    bundle_id,
                },
            };
            target.before = target.read()?;
            if target.selection.end > target.before.encode_utf16().count() || target.is_composing()
            {
                return None;
            }
            Some(target)
        })
    }

    pub fn is_focused(&self) -> Option<bool> {
        pool(|| unsafe {
            let application = Cf(AXUIElementCreateApplication(self.pid));
            AXUIElementSetMessagingTimeout(application.0, 0.15);
            if !bool_attr(application.0, "AXFrontmost")? {
                return Some(false);
            }
            let focused = attr(application.0, "AXFocusedUIElement")?;
            Some(CFEqual(self.element.0, focused.0))
        })
    }

    pub fn same_field(&self, other: &Self) -> bool {
        self.pid == other.pid && unsafe { CFEqual(self.element.0, other.element.0) }
    }
    pub fn retained(&self) -> Self {
        Self {
            element: Cf(unsafe { CFRetain(self.element.0) }),
            pid: self.pid,
            application: self.application.clone(),
            capability: self.capability,
            before: self.before.clone(),
            selection: self.selection.clone(),
        }
    }
    pub fn read(&self) -> Option<String> {
        pool(|| unsafe {
            if text_attr(self.element.0, "AXSubrole").as_deref() == Some("AXSecureTextField") {
                return None;
            }
            // Select the advertised protocol once. A failed or truncated read
            // aborts capture; it never switches to a different source.
            match self.capability {
                TextCapability::Value => text_attr(self.element.0, "AXValue")
                    .filter(|v| v.encode_utf16().count() <= MAX_UTF16 as usize),
                TextCapability::Range => {
                    let value = attr(self.element.0, "AXNumberOfCharacters")?;
                    let mut count: i64 = 0;
                    if CFGetTypeID(value.0) != CFNumberGetTypeID()
                        || !CFNumberGetValue(value.0, 4, &mut count as *mut _ as *mut c_void)
                        || !(0..=MAX_UTF16).contains(&count)
                    {
                        return None;
                    }
                    let range = CFRange {
                        location: 0,
                        length: count as isize,
                    };
                    let param = Cf(AXValueCreate(4, &range as *const _ as *const c_void));
                    if param.0.is_null() {
                        return None;
                    }
                    named("AXStringForRange", |key| {
                        let mut out = std::ptr::null();
                        let error = AXUIElementCopyParameterizedAttributeValue(
                            self.element.0,
                            key,
                            param.0,
                            &mut out,
                        );
                        let value = Cf(out);
                        if error != 0 || out.is_null() {
                            return None;
                        }
                        string(&value).filter(|v| v.encode_utf16().count() == count as usize)
                    })
                }
            }
        })
    }
}

unsafe fn bool_attr(element: *const c_void, name: &str) -> Option<bool> {
    let value = attr(element, name)?;
    (CFGetTypeID(value.0) == CFBooleanGetTypeID()).then(|| CFBooleanGetValue(value.0))
}
unsafe fn text_range(element: *const c_void, name: &str) -> Option<Range<usize>> {
    let value = attr(element, name)?;
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    if CFGetTypeID(value.0) != AXValueGetTypeID()
        || !AXValueGetValue(value.0, 4, &mut range as *mut _ as *mut c_void)
        || range.location < 0
        || range.length < 0
    {
        return None;
    }
    let start = range.location as usize;
    let end = start.checked_add(range.length as usize)?;
    (end <= MAX_UTF16 as usize).then_some(start..end)
}
unsafe fn capability(element: *const c_void) -> Option<TextCapability> {
    let mut names = std::ptr::null();
    let error = AXUIElementCopyParameterizedAttributeNames(element, &mut names);
    let names = Cf(names);
    if error == 0 && !names.0.is_null() {
        for index in 0..CFArrayGetCount(names.0) {
            let name = Cf(CFRetain(CFArrayGetValueAtIndex(names.0, index)));
            if string(&name).as_deref() == Some("AXStringForRange") {
                return Some(TextCapability::Range);
            }
        }
    }
    text_attr(element, "AXValue")
        .filter(|v| v.encode_utf16().count() <= MAX_UTF16 as usize)
        .map(|_| TextCapability::Value)
}

pub struct Observer {
    observer: Cf,
    dirty: Box<AtomicBool>,
}
unsafe extern "C" fn changed(
    _: *const c_void,
    _: *const c_void,
    _: *const c_void,
    context: *mut c_void,
) {
    (*(context as *const AtomicBool)).store(true, Ordering::Relaxed);
}
impl Observer {
    pub fn new(target: &Target) -> Option<Self> {
        unsafe {
            let mut observer = std::ptr::null();
            if AXObserverCreate(target.pid, changed, &mut observer) != 0 || observer.is_null() {
                return None;
            }
            let mut result = Self {
                observer: Cf(observer),
                dirty: Box::new(AtomicBool::new(false)),
            };
            let context = &mut *result.dirty as *mut _ as *mut c_void;
            let app = Cf(AXUIElementCreateApplication(target.pid));
            for (element, notification) in [
                (target.element.0, "AXValueChanged"),
                (target.element.0, "AXSelectedTextChanged"),
                (target.element.0, "AXUIElementDestroyed"),
                (app.0, "AXFocusedUIElementChanged"),
            ] {
                named(notification, |name| {
                    AXObserverAddNotification(observer, element, name, context);
                });
            }
            CFRunLoopAddSource(
                CFRunLoopGetCurrent(),
                AXObserverGetRunLoopSource(observer),
                kCFRunLoopDefaultMode,
            );
            Some(result)
        }
    }
    pub fn wait(&self) -> bool {
        unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.12, true);
        }
        self.dirty.swap(false, Ordering::Relaxed)
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        unsafe {
            CFRunLoopRemoveSource(
                CFRunLoopGetCurrent(),
                AXObserverGetRunLoopSource(self.observer.0),
                kCFRunLoopDefaultMode,
            );
        }
        // CF observer is released before the callback context.
    }
}

pub struct InputMonitor {
    app: tauri::AppHandle,
    token: usize,
    state: Arc<Mutex<InputState>>,
}
impl InputMonitor {
    pub fn new(app: &tauri::AppHandle, pid: i32) -> Option<Self> {
        let state = Arc::new(Mutex::new(InputState::default()));
        let captured = state.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || unsafe {
            let block = block2::RcBlock::new(move |event: *mut c_void| {
                let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
                let front: id = msg_send![workspace, frontmostApplication];
                let front_pid: i32 = msg_send![front, processIdentifier];
                if front_pid != pid { return; }
                let kind: usize = msg_send![event as id, type];
                let key: u16 = if kind == 10 { msg_send![event as id, keyCode] } else { 0 };
                let flags: usize = msg_send![event as id, modifierFlags];
                let Ok(mut state) = captured.lock() else { return; };
                let timestamp: f64 = msg_send![event as id, timestamp];
                let process: id = msg_send![class!(NSProcessInfo), processInfo];
                let uptime: f64 = msg_send![process, systemUptime];
                let Some(at) = event_instant(timestamp, uptime, Instant::now()) else {
                    state.revision += 1;
                    state.edited_at = Some(Instant::now());
                    state.submit = None;
                    return;
                };
                state.key_down(key, flags & (1 << 17) != 0, flags & (1 << 20) != 0, at);
            });
            let ptr = &*block as *const _ as *const c_void;
            let token: id = msg_send![class!(NSEvent), addGlobalMonitorForEventsMatchingMask: (1usize << 10) handler: ptr];
            if !token.is_null() { let _: id = msg_send![token, retain]; }
            if send.send(token as usize).is_err() && !token.is_null() {
                let _: () = msg_send![class!(NSEvent), removeMonitor: token];
                let _: () = msg_send![token, release];
            }
        }).ok()?;
        let token = receive.recv_timeout(Duration::from_secs(1)).ok()?;
        (token != 0).then(|| Self {
            app: app.clone(),
            token,
            state,
        })
    }
    pub(super) fn snapshot(&self) -> InputState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }
}
fn event_instant(timestamp: f64, uptime: f64, now: Instant) -> Option<Instant> {
    let age = uptime - timestamp;
    if !age.is_finite() || !(0.0..=120.0).contains(&age) {
        return None;
    }
    now.checked_sub(Duration::from_secs_f64(age))
}
impl Drop for InputMonitor {
    fn drop(&mut self) {
        let token = self.token;
        let _ = self.app.run_on_main_thread(move || unsafe {
            let token = token as id;
            let _: () = msg_send![class!(NSEvent), removeMonitor: token];
            let _: () = msg_send![token, release];
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRetain(value: *const c_void) -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    }

    #[test]
    fn input_timestamp_preserves_event_order_and_rejects_invalid_clocks() {
        let now = Instant::now();
        assert_eq!(
            event_instant(50.0, 50.25, now),
            now.checked_sub(Duration::from_millis(250))
        );
        assert!(event_instant(f64::NAN, 50.0, now).is_none());
        assert!(event_instant(51.0, 50.0, now).is_none());
        assert!(event_instant(1.0, 200.0, now).is_none());
    }

    /// Runs against a real out-of-process AppKit text view with synthetic text.
    /// No activation, clipboard access, or synthetic keyboard input is needed.
    #[test]
    #[ignore = "set LINTY_CORRECTION_FIXTURE to the compiled Swift fixture"]
    fn native_text_ranges_and_notifications() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Child(
            std::process::Command::new(std::env::var("LINTY_CORRECTION_FIXTURE").unwrap())
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id() as i32;
        let mut target = None;
        for _ in 0..20 {
            target = pool(|| unsafe {
                let mut nodes = vec![Cf(AXUIElementCreateApplication(pid))];
                let mut visited = 0;
                while let Some(node) = nodes.pop() {
                    visited += 1;
                    if visited > 32 {
                        break;
                    }
                    if text_attr(node.0, "AXRole").as_deref() == Some("AXTextArea") {
                        return Some(Target {
                            capability: capability(node.0).expect("text capability"),
                            before: String::new(),
                            selection: 0..0,
                            element: node,
                            pid,
                            application: super::super::ObservedApplication {
                                name: "Synthetic AppKit fixture".into(),
                                bundle_id: None,
                            },
                        });
                    }
                    let attribute = if visited == 1 {
                        "AXWindows"
                    } else {
                        "AXChildren"
                    };
                    if let Some(children) = attr(node.0, attribute) {
                        for index in 0..CFArrayGetCount(children.0) {
                            nodes.push(Cf(CFRetain(CFArrayGetValueAtIndex(children.0, index))));
                        }
                    }
                }
                None
            });
            if target.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let target = target.expect("AppKit text view must be accessible");
        assert!(!target.is_composing());
        assert_eq!(
            target.read().as_deref(),
            Some("My name is Hari Shekhar. I go to YOLO.")
        );
        let observer = Observer::new(&target).unwrap();
        let started = Instant::now();
        let mut values = Vec::new();
        let mut notifications = 0;
        while started.elapsed() < Duration::from_secs(4) {
            if observer.wait() {
                notifications += 1;
            }
            if let Some(value) = target.read() {
                if values.last() != Some(&value) {
                    values.push(value);
                }
            }
            if values.last().is_some_and(String::is_empty) {
                break;
            }
        }
        assert!(values
            .iter()
            .any(|v| v == "My name is Harishekhar. I go to YULU."));
        assert_eq!(values.last().map(String::as_str), Some(""));
        assert!(
            notifications >= 2,
            "AX callbacks must wake the watcher for real edits"
        );
    }
    /// Uses real focus departure as well as real AX edits. The fixture briefly
    /// activates its own synthetic window and restores the preceding application.
    #[test]
    #[ignore = "set LINTY_CORRECTION_FIXTURE; briefly activates a synthetic AppKit window"]
    fn native_editing_session_finishes_one_batch_on_focus_departure() {
        use super::super::{
            session::{EditingSession, Outcome},
            Active,
        };
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Child(
            std::process::Command::new(std::env::var("LINTY_CORRECTION_FIXTURE").unwrap())
                .arg("--session")
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id() as i32;
        let mut target = None;
        for _ in 0..30 {
            target = Target::for_pid(pid);
            if target.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let target = target.expect("fixture must expose its focused editable field");
        let original = target.read().unwrap();
        assert_eq!(original, "My name is Hari Shekhar. I go to YOLO.");
        let mut session = EditingSession::new(original.clone());
        assert!(session.insert(
            "fixture-dictation".into(),
            original.clone(),
            "",
            0..0,
            original
        ));
        let mut active = Active {
            observer: Observer::new(&target),
            target,
            input: None,
            session,
        };
        let start = Instant::now();
        let mut finished = false;
        while start.elapsed() < Duration::from_secs(5) {
            active.wait();
            match active.sample() {
                Outcome::Continue => {}
                Outcome::Discard => panic!("real fixture session was discarded"),
                Outcome::Finish => {
                    finished = true;
                    break;
                }
            }
        }
        assert!(
            finished,
            "focus departure must finalize without a submit hook"
        );
        assert!(
            start.elapsed() >= Duration::from_secs(2),
            "edit pauses cannot finalize"
        );
        let batch = active.session.finish(active.target.application.clone());
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].pairs.len(), 2);
        assert_eq!(batch[0].pairs[0].to, "Harishekhar.");
        assert_eq!(batch[0].pairs[1].to, "YULU.");
    }
}
