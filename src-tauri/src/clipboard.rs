//! Full NSPasteboard clipboard preservation via raw objc FFI.
//!
//! Snapshots ALL pasteboard item types (images, files, RTF, etc.) as raw bytes,
//! writes transient text via NSPasteboardItemDataProvider lazy delivery, then
//! restores the original clipboard on a timer scheduled after the paste keystroke.
//! Restore is deliberately time-based, NOT read-based: clipboard managers
//! (Maccy, Raycast, Paste) read the pasteboard the moment it changes, and a
//! read-triggered restore could replace the transcript before the target app
//! services Cmd+V — pasting the OLD clipboard content instead.
//! Uses the same raw `objc_msgSend` pattern as `fnkey.rs` and `permissions.rs`.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const u8) -> *const c_void;
    fn sel_registerName(name: *const u8) -> *const c_void;
    fn objc_msgSend();
    fn objc_allocateClassPair(
        superclass: *const c_void,
        name: *const u8,
        extra_bytes: usize,
    ) -> *mut c_void;
    fn objc_registerClassPair(cls: *mut c_void);
    fn class_addMethod(
        cls: *mut c_void,
        sel: *const c_void,
        imp: *const c_void,
        types: *const u8,
    ) -> bool;
    fn class_addProtocol(cls: *mut c_void, protocol: *const c_void) -> bool;
    fn objc_getProtocol(name: *const u8) -> *const c_void;
}

// ── Helper: call selectors via objc_msgSend with various signatures ──

unsafe fn msg_send_0(obj: *const c_void, sel: *const c_void) -> *const c_void {
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(obj, sel)
}

unsafe fn msg_send_1(obj: *const c_void, sel: *const c_void, arg: *const c_void) -> *const c_void {
    let send: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) -> *const c_void =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(obj, sel, arg)
}

unsafe fn msg_send_i64(obj: *const c_void, sel: *const c_void) -> i64 {
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> i64 =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(obj, sel)
}

unsafe fn msg_send_u64(obj: *const c_void, sel: *const c_void) -> u64 {
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> u64 =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(obj, sel)
}

// ── NSString helpers ──

unsafe fn nsstring_from_str(s: &str) -> *const c_void {
    let cls = objc_getClass(b"NSString\0".as_ptr());
    let sel = sel_registerName(b"stringWithUTF8String:\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void, *const u8) -> *const c_void =
        std::mem::transmute(objc_msgSend as *const c_void);
    let cstr = format!("{}\0", s);
    send(cls, sel, cstr.as_ptr())
}

unsafe fn nsstring_to_string(nsstr: *const c_void) -> Option<String> {
    if nsstr.is_null() {
        return None;
    }
    let sel = sel_registerName(b"UTF8String\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> *const u8 =
        std::mem::transmute(objc_msgSend as *const c_void);
    let ptr = send(nsstr, sel);
    if ptr.is_null() {
        return None;
    }
    let cstr = std::ffi::CStr::from_ptr(ptr as *const i8);
    cstr.to_str().ok().map(|s| s.to_string())
}

// ── NSData helpers ──

unsafe fn nsdata_to_vec(data: *const c_void, remaining: usize) -> Result<Vec<u8>, String> {
    if data.is_null() {
        return Ok(Vec::new());
    }
    let length = msg_send_u64(data, sel_registerName(b"length\0".as_ptr())) as usize;
    checked_snapshot_size(MAX_SNAPSHOT_BYTES - remaining, length)?;
    if length == 0 {
        return Ok(Vec::new());
    }
    let bytes_sel = sel_registerName(b"bytes\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void) -> *const u8 =
        std::mem::transmute(objc_msgSend as *const c_void);
    let bytes_ptr = send(data, bytes_sel);
    if bytes_ptr.is_null() {
        return Ok(Vec::new());
    }
    Ok(std::slice::from_raw_parts(bytes_ptr, length).to_vec())
}

unsafe fn nsdata_from_vec(bytes: &[u8]) -> *const c_void {
    let cls = objc_getClass(b"NSData\0".as_ptr());
    let sel = sel_registerName(b"dataWithBytes:length:\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void, *const u8, u64) -> *const c_void =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(cls, sel, bytes.as_ptr(), bytes.len() as u64)
}

// ── NSArray helpers ──

unsafe fn nsarray_count(arr: *const c_void) -> u64 {
    msg_send_u64(arr, sel_registerName(b"count\0".as_ptr()))
}

unsafe fn nsarray_object_at(arr: *const c_void, index: u64) -> *const c_void {
    let sel = sel_registerName(b"objectAtIndex:\0".as_ptr());
    let send: unsafe extern "C" fn(*const c_void, *const c_void, u64) -> *const c_void =
        std::mem::transmute(objc_msgSend as *const c_void);
    send(arr, sel, index)
}

// ── Snapshot types ──

pub struct PasteboardItemSnapshot {
    pub types_data: Vec<(String, Vec<u8>)>,
}

pub struct ClipboardSnapshot {
    pub items: Vec<PasteboardItemSnapshot>,
    #[allow(dead_code)]
    pub change_count: i64,
}

pub struct ClipboardState {
    pub snapshot: ClipboardSnapshot,
    pub post_write_change_count: i64,
}

// ── Global state stored in Rust ──

static CLIPBOARD_STATE: Mutex<Option<ClipboardState>> = Mutex::new(None);

// ── Lazy data provider state ──

struct ProviderState {
    text: String,
    consumed: AtomicBool,
}

/// Pointer to heap-allocated ProviderState (0 = none)
static PROVIDER_STATE: AtomicUsize = AtomicUsize::new(0);

/// Registered ObjC class pointer (0 = not yet registered)
static PROVIDER_CLASS: AtomicUsize = AtomicUsize::new(0);

// ── NSPasteboardItemDataProvider implementation ──

/// One-time ObjC class registration for our lazy data provider.
/// Creates a `LintyPasteProvider` class that conforms to `NSPasteboardItemDataProvider`.
fn register_pasteboard_provider_class() -> *const c_void {
    let existing = PROVIDER_CLASS.load(Ordering::Acquire);
    if existing != 0 {
        return existing as *const c_void;
    }

    unsafe {
        let superclass = objc_getClass(b"NSObject\0".as_ptr());
        let cls = objc_allocateClassPair(superclass, b"LintyPasteProvider\0".as_ptr(), 0);
        if cls.is_null() {
            // Class already exists (race) — fetch it
            let existing = objc_getClass(b"LintyPasteProvider\0".as_ptr());
            PROVIDER_CLASS.store(existing as usize, Ordering::Release);
            return existing;
        }

        // Conform to NSPasteboardItemDataProvider protocol
        let protocol = objc_getProtocol(b"NSPasteboardItemDataProvider\0".as_ptr());
        if !protocol.is_null() {
            class_addProtocol(cls, protocol);
        }

        // pasteboard:item:provideDataForType: — called when target app reads our data
        let provide_sel = sel_registerName(b"pasteboard:item:provideDataForType:\0".as_ptr());
        class_addMethod(
            cls,
            provide_sel,
            provide_data_for_type_imp as *const c_void,
            b"v@:@@@\0".as_ptr(),
        );

        // pasteboardFinishedWithDataProvider: — cleanup when pasteboard releases provider
        let finished_sel = sel_registerName(b"pasteboardFinishedWithDataProvider:\0".as_ptr());
        class_addMethod(
            cls,
            finished_sel,
            pasteboard_finished_imp as *const c_void,
            b"v@:@\0".as_ptr(),
        );

        objc_registerClassPair(cls);
        PROVIDER_CLASS.store(cls as usize, Ordering::Release);
        cls as *const c_void
    }
}

/// IMP for `pasteboard:item:provideDataForType:`.
/// Called by macOS when ANY app reads the pasted data — the paste target, but
/// also clipboard managers polling changeCount. Fulfills the lazy promise with
/// the transcribed text (once; later reads get the cached item data). Restore
/// is NOT triggered here — see `schedule_restore`.
extern "C" fn provide_data_for_type_imp(
    _self: *const c_void,
    _cmd: *const c_void,
    _pasteboard: *const c_void,
    item: *const c_void,
    _type_uti: *const c_void,
) {
    let ptr = PROVIDER_STATE.load(Ordering::Acquire);
    if ptr == 0 {
        return;
    }

    let state = unsafe { &*(ptr as *const ProviderState) };

    // Guard against multiple reads — only fulfill once
    if state.consumed.swap(true, Ordering::AcqRel) {
        return;
    }

    unsafe {
        // Fulfill with NSData (not setString:forType: to avoid recursive provider trigger)
        let utf8_type = nsstring_from_str("public.utf8-plain-text");
        let text_bytes = state.text.as_bytes();
        let ns_data = nsdata_from_vec(text_bytes);

        let set_data_sel = sel_registerName(b"setData:forType:\0".as_ptr());
        let send: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
        ) -> bool = std::mem::transmute(objc_msgSend as *const c_void);
        send(item, set_data_sel, ns_data, utf8_type);
    }
}

/// IMP for `pasteboardFinishedWithDataProvider:`.
/// Called when the pasteboard no longer needs our provider (after data consumption or clear).
/// Cleans up the heap-allocated ProviderState to prevent leaks.
extern "C" fn pasteboard_finished_imp(
    _self: *const c_void,
    _cmd: *const c_void,
    _pasteboard: *const c_void,
) {
    let ptr = PROVIDER_STATE.swap(0, Ordering::AcqRel);
    if ptr != 0 {
        unsafe {
            let _ = Box::from_raw(ptr as *mut ProviderState);
        }
        log::debug!("[clipboard] provider state cleaned up");
    }
}

/// Write text to pasteboard via lazy data provider (NSPasteboardItemDataProvider).
/// Instead of eagerly writing text bytes, registers a provider that macOS calls back
/// when any consumer reads the data; this does not verify insertion into the target.
fn write_clipboard_with_lazy_provider(text: &str) -> Result<i64, String> {
    let provider_cls = register_pasteboard_provider_class();

    unsafe {
        let pb = get_general_pasteboard();

        // clearContents first — this fires pasteboardFinishedWithDataProvider: for any
        // previous provider synchronously, cleaning up the old PROVIDER_STATE.
        let cleared_count = msg_send_i64(pb, sel_registerName(b"clearContents\0".as_ptr()));
        // Own the cleared pasteboard even if a later allocation/publication
        // fails. Recovery can restore it without overwriting a newer user copy.
        if let Some(state) = CLIPBOARD_STATE.lock().unwrap().as_mut() {
            state.post_write_change_count = cleared_count;
        }

        // Now safe to store new provider state (old one is cleaned up)
        let state = Box::new(ProviderState {
            text: text.to_string(),
            consumed: AtomicBool::new(false),
        });
        let old_ptr = PROVIDER_STATE.swap(Box::into_raw(state) as usize, Ordering::AcqRel);
        if old_ptr != 0 {
            // Shouldn't happen after clearContents, but guard against leaks
            let _ = Box::from_raw(old_ptr as *mut ProviderState);
        }

        // Create NSPasteboardItem
        let item_cls = objc_getClass(b"NSPasteboardItem\0".as_ptr());
        let item = msg_send_0(
            msg_send_0(item_cls, sel_registerName(b"alloc\0".as_ptr())),
            sel_registerName(b"init\0".as_ptr()),
        );
        if item.is_null() {
            return Err("Failed to create NSPasteboardItem".into());
        }

        // Create provider instance
        let provider = msg_send_0(
            msg_send_0(provider_cls, sel_registerName(b"alloc\0".as_ptr())),
            sel_registerName(b"init\0".as_ptr()),
        );
        if provider.is_null() {
            return Err("Failed to create provider instance".into());
        }

        // Register lazy data provider for UTF-8 text type
        let utf8_type = nsstring_from_str("public.utf8-plain-text");
        let array_cls = objc_getClass(b"NSArray\0".as_ptr());
        let types_array = msg_send_1(
            array_cls,
            sel_registerName(b"arrayWithObject:\0".as_ptr()),
            utf8_type,
        );

        let set_provider_sel = sel_registerName(b"setDataProvider:forTypes:\0".as_ptr());
        let send_set_provider: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
        ) -> bool = std::mem::transmute(objc_msgSend as *const c_void);
        let ok = send_set_provider(item, set_provider_sel, provider, types_array);
        if !ok {
            return Err("setDataProvider:forTypes: returned NO".into());
        }

        // Set TransientType marker eagerly (just a marker, no lazy delivery needed)
        let set_str_sel = sel_registerName(b"setString:forType:\0".as_ptr());
        let send_set_str: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
        ) -> bool = std::mem::transmute(objc_msgSend as *const c_void);
        let transient_type = nsstring_from_str("org.nspasteboard.TransientType");
        let empty_str = nsstring_from_str("");
        send_set_str(item, set_str_sel, empty_str, transient_type);

        // writeObjects: with NSArray containing our item
        let items_array = msg_send_1(
            array_cls,
            sel_registerName(b"arrayWithObject:\0".as_ptr()),
            item,
        );

        let write_sel = sel_registerName(b"writeObjects:\0".as_ptr());
        let send_write: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        let ok = send_write(pb, write_sel, items_array);

        if !ok {
            return Err("writeObjects: returned NO".into());
        }

        let new_count = msg_send_i64(pb, sel_registerName(b"changeCount\0".as_ptr()));
        Ok(new_count)
    }
}

// ── Public API ──

/// Snapshot all items and types from [NSPasteboard generalPasteboard].
/// Refuse an incomplete snapshot so the caller leaves the clipboard untouched.
pub fn snapshot_clipboard() -> Result<ClipboardSnapshot, String> {
    unsafe {
        let pb = get_general_pasteboard();
        let change_count = msg_send_i64(pb, sel_registerName(b"changeCount\0".as_ptr()));

        let items = msg_send_0(pb, sel_registerName(b"pasteboardItems\0".as_ptr()));
        let count = if items.is_null() {
            0
        } else {
            nsarray_count(items)
        };
        if count == 0 {
            return Ok(ClipboardSnapshot {
                items: Vec::new(),
                change_count,
            });
        }

        let mut snapshot_items = Vec::new();
        let mut total_bytes: usize = 0;

        for i in 0..count {
            let item = nsarray_object_at(items, i);
            if item.is_null() {
                continue;
            }

            let types = msg_send_0(item, sel_registerName(b"types\0".as_ptr()));
            if types.is_null() {
                continue;
            }

            let type_count = nsarray_count(types);
            let mut types_data = Vec::new();

            for j in 0..type_count {
                let uti = nsarray_object_at(types, j);
                if let Some(uti_str) = nsstring_to_string(uti) {
                    // Skip dynamic UTIs (dyn.* — transient, not restorable)
                    if uti_str.starts_with("dyn.") {
                        continue;
                    }

                    let data = msg_send_1(item, sel_registerName(b"dataForType:\0".as_ptr()), uti);
                    if !data.is_null() {
                        let bytes = nsdata_to_vec(data, MAX_SNAPSHOT_BYTES - total_bytes)?;
                        total_bytes += bytes.len();
                        types_data.push((uti_str, bytes));
                    }
                }
            }

            if !types_data.is_empty() {
                snapshot_items.push(PasteboardItemSnapshot { types_data });
            }
        }

        Ok(ClipboardSnapshot {
            items: snapshot_items,
            change_count,
        })
    }
}

/// Clear pasteboard and write text via lazy data provider with TransientType marker.
/// Returns the post-write changeCount.
pub fn write_transient_text(text: &str) -> Result<i64, String> {
    write_clipboard_with_lazy_provider(text)
}

/// Restore the previously snapshotted clipboard content.
/// Skips restore if the user has copied something new during the delay.
pub fn restore_clipboard(state: &ClipboardState) -> Result<(), String> {
    unsafe {
        let pb = get_general_pasteboard();
        let current_count = msg_send_i64(pb, sel_registerName(b"changeCount\0".as_ptr()));

        // If changeCount differs from post-write, user copied something new — don't overwrite
        if current_count != state.post_write_change_count {
            log::debug!(
                "[clipboard] changeCount mismatch ({} != {}), skipping restore",
                current_count,
                state.post_write_change_count
            );
            return Ok(());
        }

        // If snapshot was empty, just clear the pasteboard
        if state.snapshot.items.is_empty() {
            msg_send_i64(pb, sel_registerName(b"clearContents\0".as_ptr()));
            return Ok(());
        }

        // clearContents before restoring
        msg_send_i64(pb, sel_registerName(b"clearContents\0".as_ptr()));

        // Build NSMutableArray of NSPasteboardItem
        let mut_array_cls = objc_getClass(b"NSMutableArray\0".as_ptr());
        let items_array = msg_send_0(
            msg_send_0(mut_array_cls, sel_registerName(b"alloc\0".as_ptr())),
            sel_registerName(b"init\0".as_ptr()),
        );

        let add_sel = sel_registerName(b"addObject:\0".as_ptr());
        let set_data_sel = sel_registerName(b"setData:forType:\0".as_ptr());
        let set_data_send: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const c_void,
        ) -> bool = std::mem::transmute(objc_msgSend as *const c_void);

        let item_cls = objc_getClass(b"NSPasteboardItem\0".as_ptr());

        for snapshot_item in &state.snapshot.items {
            let item = msg_send_0(
                msg_send_0(item_cls, sel_registerName(b"alloc\0".as_ptr())),
                sel_registerName(b"init\0".as_ptr()),
            );
            if item.is_null() {
                continue;
            }

            for (uti, bytes) in &snapshot_item.types_data {
                let ns_type = nsstring_from_str(uti);
                let ns_data = nsdata_from_vec(bytes);
                set_data_send(item, set_data_sel, ns_data, ns_type);
            }

            // Mark as restored so clipboard history apps don't create duplicate entries
            let restored_type = nsstring_from_str("org.nspasteboard.RestoredType");
            let empty_data = nsdata_from_vec(&[]);
            set_data_send(item, set_data_sel, empty_data, restored_type);

            msg_send_1(items_array, add_sel, item);
        }

        let write_sel = sel_registerName(b"writeObjects:\0".as_ptr());
        let send_write: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        let ok = send_write(pb, write_sel, items_array);

        if !ok {
            return Err("writeObjects: failed during restore".into());
        }

        log::debug!("[clipboard] restored {} items", state.snapshot.items.len());
        Ok(())
    }
}

// ── Tauri command wrappers ──

/// Snapshot the current clipboard into module-level state.
// Serialize publication and restoration across timer and command threads. The
// generation check must be in the same critical section as the OS write.
static CLIPBOARD_OPERATION: Mutex<()> = Mutex::new(());

pub fn cmd_snapshot() -> Result<(), String> {
    let _operation = CLIPBOARD_OPERATION.lock().map_err(|e| e.to_string())?;
    // Settle our previous transient publication before snapshotting the next.
    // changeCount still protects a newer user copy.
    restore_owned(None)?;
    RESTORE_GENERATION.fetch_add(1, Ordering::AcqRel);
    // Clear stale state even if this snapshot fails; the frontend's recovery
    // must never restore an earlier paste over the clipboard we preserved.
    *CLIPBOARD_STATE.lock().unwrap() = None;
    let snapshot = snapshot_clipboard()?;
    *CLIPBOARD_STATE.lock().unwrap() = Some(ClipboardState {
        snapshot,
        post_write_change_count: 0,
    });
    Ok(())
}

/// Write transient text and record the post-write changeCount.
pub fn cmd_write_transient(text: &str) -> Result<(), String> {
    let _operation = CLIPBOARD_OPERATION.lock().map_err(|e| e.to_string())?;
    // New paste session — any restore timer from a previous session is now stale
    RESTORE_GENERATION.fetch_add(1, Ordering::AcqRel);
    let change_count = write_transient_text(text)?;
    let mut guard = CLIPBOARD_STATE.lock().unwrap();
    if let Some(state) = guard.as_mut() {
        state.post_write_change_count = change_count;
    }
    Ok(())
}

/// Delay between the paste keystroke being posted and the clipboard restore.
/// Generous so slow apps (Electron, remote desktops) finish reading the
/// transcript before it's replaced; the transcript carries TransientType so
/// clipboard managers ignore it during this window.
pub const RESTORE_DELAY_MS: u64 = 800;

/// Monotonic paste-session counter. A scheduled restore fires only if no newer
/// write_transient happened meanwhile — otherwise back-to-back dictations would
/// have session N's timer restore over session N+1's not-yet-pasted transcript.
static RESTORE_GENERATION: AtomicUsize = AtomicUsize::new(0);

/// Restore the snapshotted clipboard after `delay_ms`, unless a newer paste
/// session started. Called right after the Cmd+V keystroke is posted.
pub fn schedule_restore(delay_ms: u64) {
    let generation = RESTORE_GENERATION.load(Ordering::Acquire);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let Ok(_operation) = CLIPBOARD_OPERATION.lock() else {
            return;
        };
        if let Err(e) = restore_owned(Some(generation)) {
            log::warn!("[clipboard] scheduled restore failed: {}", e);
        }
    });
}

/// Restore clipboard from stored state, then clear the stored state.
pub fn cmd_restore() -> Result<(), String> {
    let _operation = CLIPBOARD_OPERATION.lock().map_err(|e| e.to_string())?;
    restore_owned(None)
}

/// Caller holds CLIPBOARD_OPERATION until the OS write is finished.
fn restore_owned(expected_generation: Option<usize>) -> Result<(), String> {
    if expected_generation
        .is_some_and(|expected| RESTORE_GENERATION.load(Ordering::Acquire) != expected)
    {
        return Ok(());
    }
    let state = {
        let mut guard = CLIPBOARD_STATE.lock().unwrap();
        guard.take()
    };
    match state {
        Some(s) => restore_clipboard(&s),
        None => {
            log::debug!("[clipboard] no snapshot to restore");
            Ok(())
        }
    }
}

// ── Internal helpers ──

unsafe fn get_general_pasteboard() -> *const c_void {
    let cls = objc_getClass(b"NSPasteboard\0".as_ptr());
    msg_send_0(cls, sel_registerName(b"generalPasteboard\0".as_ptr()))
}

const MAX_SNAPSHOT_BYTES: usize = 100 * 1024 * 1024;

fn checked_snapshot_size(total: usize, next: usize) -> Result<usize, String> {
    total
        .checked_add(next)
        .filter(|size| *size <= MAX_SNAPSHOT_BYTES)
        .ok_or_else(|| {
            "Clipboard is too large to preserve. Copy your transcript from History.".into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_budget_refuses_oversized_items_before_copying() {
        assert_eq!(checked_snapshot_size(0, 0).unwrap(), 0);
        assert_eq!(
            checked_snapshot_size(MAX_SNAPSHOT_BYTES - 1, 1).unwrap(),
            MAX_SNAPSHOT_BYTES
        );
        assert!(checked_snapshot_size(0, MAX_SNAPSHOT_BYTES + 1).is_err());
        assert!(checked_snapshot_size(MAX_SNAPSHOT_BYTES, 1).is_err());
        assert!(checked_snapshot_size(1, usize::MAX).is_err());
    }
}
