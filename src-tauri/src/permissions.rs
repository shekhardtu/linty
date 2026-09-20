//! Microphone permission check/request via AVFoundation (macOS).
//!
//! Uses AVCaptureDevice API via raw objc FFI, same pattern as fnkey.rs.

use std::ffi::c_void;
use std::sync::mpsc;

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVMediaTypeAudio: *const c_void;
}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const u8) -> *const c_void;
    fn sel_registerName(name: *const u8) -> *const c_void;
    fn objc_msgSend();
}

extern "C" {
    static _NSConcreteStackBlock: *const c_void;
}

/// Check microphone authorization status.
/// Returns: `"authorized"`, `"denied"`, `"not_determined"`, or `"restricted"`.
pub fn check_microphone_permission() -> String {
    unsafe {
        let cls = objc_getClass(b"AVCaptureDevice\0".as_ptr());
        let sel = sel_registerName(b"authorizationStatusForMediaType:\0".as_ptr());

        let send: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void) -> i64 =
            std::mem::transmute(objc_msgSend as *const c_void);

        let status = send(cls, sel, AVMediaTypeAudio);
        let result = match status {
            0 => "not_determined",
            1 => "restricted",
            2 => "denied",
            3 => "authorized",
            _ => "not_determined",
        };
        log::debug!(
            "[mic] check_microphone_permission: status={} ({})",
            status,
            result
        );
        result.to_string()
    }
}

// ── Block layout for requestAccess completionHandler ──

#[repr(C)]
struct CompletionBlockDescriptor {
    reserved: u64,
    size: u64,
    copy_helper: Option<unsafe extern "C" fn(*mut c_void, *const c_void)>,
    dispose_helper: Option<unsafe extern "C" fn(*mut c_void)>,
}

#[repr(C)]
struct CompletionBlock {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: unsafe extern "C" fn(*mut CompletionBlock, u8),
    descriptor: *const CompletionBlockDescriptor,
    tx: *const mpsc::Sender<bool>,
}

unsafe extern "C" fn completion_invoke(block: *mut CompletionBlock, granted: u8) {
    let tx = &*(*block).tx;
    let _ = tx.send(granted != 0);
}

unsafe extern "C" fn completion_copy_helper(dst: *mut c_void, src: *const c_void) {
    let src_block = src as *const CompletionBlock;
    let dst_block = dst as *mut CompletionBlock;
    (*dst_block).tx = (*src_block).tx;
}

unsafe extern "C" fn completion_dispose_helper(_block: *mut c_void) {}

/// Request microphone permission from macOS. Blocks until the user responds.
/// Returns `true` if granted.
pub fn request_microphone_permission() -> bool {
    log::info!("[mic] request_microphone_permission: starting request");
    let (tx, rx) = mpsc::channel();
    let tx_ptr = Box::into_raw(Box::new(tx));

    unsafe {
        static DESCRIPTOR: CompletionBlockDescriptor = CompletionBlockDescriptor {
            reserved: 0,
            size: std::mem::size_of::<CompletionBlock>() as u64,
            copy_helper: Some(completion_copy_helper),
            dispose_helper: Some(completion_dispose_helper),
        };

        let block = Box::new(CompletionBlock {
            isa: _NSConcreteStackBlock,
            flags: 1 << 25, // BLOCK_HAS_COPY_DISPOSE
            reserved: 0,
            invoke: completion_invoke,
            descriptor: &DESCRIPTOR,
            tx: tx_ptr,
        });
        let block_ptr = Box::into_raw(block);

        let cls = objc_getClass(b"AVCaptureDevice\0".as_ptr());
        let sel = sel_registerName(b"requestAccessForMediaType:completionHandler:\0".as_ptr());

        let send: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            *const CompletionBlock,
        ) = std::mem::transmute(objc_msgSend as *const c_void);

        send(cls, sel, AVMediaTypeAudio, block_ptr);
    }

    // Block until macOS calls the completion handler (30s timeout)
    let granted = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap_or(false);
    log::info!("[mic] request_microphone_permission: granted={}", granted);
    granted
}
