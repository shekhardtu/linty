//! Microphone permission check/request via AVFoundation (macOS).
//!
//! Uses AVCaptureDevice API via raw objc FFI, same pattern as fnkey.rs.

use block2::RcBlock;
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

/// Request microphone permission from macOS. Blocks until the user responds.
/// Returns `true` if granted.
pub fn request_microphone_permission() -> bool {
    log::info!("[mic] request_microphone_permission: starting request");
    let (tx, rx) = mpsc::channel();

    unsafe {
        // The framework's copy owns the sender until completion, including
        // when the user responds after our receive timeout.
        let block = RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });

        let cls = objc_getClass(b"AVCaptureDevice\0".as_ptr());
        let sel = sel_registerName(b"requestAccessForMediaType:completionHandler:\0".as_ptr());

        let send: unsafe extern "C" fn(*const c_void, *const c_void, *const c_void, *const c_void) =
            std::mem::transmute(objc_msgSend as *const c_void);

        send(cls, sel, AVMediaTypeAudio, RcBlock::as_ptr(&block).cast());
    }

    // Block until macOS calls the completion handler (30s timeout)
    let granted = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap_or(false);
    log::info!("[mic] request_microphone_permission: granted={}", granted);
    granted
}
