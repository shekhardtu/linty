/// Only app identity is captured, once at the start of a dictation.
/// No window titles, URLs, process scans, or background activity log.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIdentity {
    pub name: String,
    pub bundle_id: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn frontmost_application() -> Option<ApplicationIdentity> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    unsafe fn string(value: *mut Object) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![value, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    // start_recording is a synchronous Tauri command, on the main thread.
    // Copy the strings before draining the autorelease pool.
    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut Object = msg_send![workspace, frontmostApplication];
        let result = if app.is_null() {
            None
        } else {
            let name: *mut Object = msg_send![app, localizedName];
            let bundle: *mut Object = msg_send![app, bundleIdentifier];
            string(name).map(|name| ApplicationIdentity {
                name,
                bundle_id: string(bundle),
            })
        };
        let _: () = msg_send![pool, drain];
        result
    }
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_application() -> Option<ApplicationIdentity> {
    None
}

/// Rendered size of app icons handed to the UI, in points. Rows show them at
/// 16–28 px, so 64 px stays crisp on Retina while keeping the PNG a few KB.
const ICON_POINTS: f64 = 64.0;

/// The installed app's icon (from its bundle, via NSWorkspace) as PNG bytes.
/// `None` when no app with that bundle id is installed or the icon can't be rendered.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // cocoa types, same as the rest of the AppKit FFI in this crate
pub fn app_icon_png(bundle_id: &str) -> Option<Vec<u8>> {
    use cocoa::base::nil;
    use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;

    // NSBitmapImageFileTypePNG
    const PNG_FILE_TYPE: u64 = 4;

    // SAFETY: Called from a synchronous Tauri command, i.e. the main thread,
    // which is where AppKit expects NSWorkspace/NSImage work. The bundle-id
    // string and bitmap rep are owned (+1) and released explicitly; the
    // autoreleased URL/image/data are only used before the pool drains, and the
    // PNG bytes are copied out of the NSData before that.
    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        let bundle: *mut Object = NSString::alloc(nil).init_str(bundle_id);
        let mut png: Option<Vec<u8>> = None;

        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let url: *mut Object = msg_send![workspace, URLForApplicationWithBundleIdentifier: bundle];
        if !url.is_null() {
            let path: *mut Object = msg_send![url, path];
            let image: *mut Object = msg_send![workspace, iconForFile: path];
            if !image.is_null() {
                let size = NSSize::new(ICON_POINTS, ICON_POINTS);
                let _: () = msg_send![image, setSize: size];
                let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
                let no_context: *mut Object = std::ptr::null_mut();
                let no_hints: *mut Object = std::ptr::null_mut();
                let cg_image: *mut c_void = msg_send![
                    image,
                    CGImageForProposedRect: &mut rect as *mut NSRect
                    context: no_context
                    hints: no_hints
                ];
                if !cg_image.is_null() {
                    let rep: *mut Object = msg_send![class!(NSBitmapImageRep), alloc];
                    let rep: *mut Object = msg_send![rep, initWithCGImage: cg_image];
                    if !rep.is_null() {
                        let props: *mut Object = msg_send![class!(NSDictionary), dictionary];
                        let data: *mut Object = msg_send![rep, representationUsingType: PNG_FILE_TYPE properties: props];
                        if !data.is_null() {
                            let len: usize = msg_send![data, length];
                            let bytes: *const u8 = msg_send![data, bytes];
                            if !bytes.is_null() && len > 0 {
                                png = Some(std::slice::from_raw_parts(bytes, len).to_vec());
                            }
                        }
                        let _: () = msg_send![rep, release];
                    }
                }
            }
        }

        let _: () = msg_send![bundle, release];
        let _: () = msg_send![pool, drain];
        png
    }
}

#[cfg(not(target_os = "macos"))]
pub fn app_icon_png(_bundle_id: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::app_icon_png;

    #[test]
    fn finder_icon_renders_as_png() {
        let png = app_icon_png("com.apple.finder").expect("Finder is always installed");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG header");
        assert!(
            png.len() < 200 * 1024,
            "icon unexpectedly large: {} bytes",
            png.len()
        );
    }

    #[test]
    fn unknown_bundle_has_no_icon() {
        assert!(app_icon_png("ai.linty.does-not-exist").is_none());
    }
}
