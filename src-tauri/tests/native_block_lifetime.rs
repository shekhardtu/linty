//! Exercises AppKit's real block ownership on the main thread. Events are
//! posted only to this test process; no system input or permission prompts.
#![allow(deprecated, unexpected_cfgs)]

#[cfg(target_os = "macos")]
fn main() {
    use block2::RcBlock;
    use cocoa::{
        appkit::{NSApplication, NSApplicationActivationPolicy},
        base::{id, nil, YES},
        foundation::{NSAutoreleasePool, NSPoint, NSString},
    };
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    unsafe {
        let outer = cocoa::foundation::NSAutoreleasePool::new(nil);
        let app = id::sharedApplication(nil);
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyProhibited,
        );
        // Repeat installation/removal as on wake or partial monitor repair.
        for _ in 0..50 {
            let state = Arc::new(AtomicUsize::new(0));
            let weak = Arc::downgrade(&state);
            let pool = cocoa::foundation::NSAutoreleasePool::new(nil);
            let global_state = Arc::new(AtomicUsize::new(0));
            let global_weak = Arc::downgrade(&global_state);
            let global = RcBlock::new(move |_event: *const c_void| {
                global_state.fetch_add(1, Ordering::Relaxed);
            });
            let global_token: id = msg_send![class!(NSEvent),
                addGlobalMonitorForEventsMatchingMask: (1usize << 12)
                handler: RcBlock::as_ptr(&global).cast::<c_void>()];
            assert!(!global_token.is_null());
            let _: id = msg_send![global_token, retain];
            let local = RcBlock::new(move |event: *const c_void| -> *const c_void {
                let marker: isize = msg_send![event as id, data1];
                if marker == 7319 {
                    state.fetch_add(1, Ordering::Relaxed);
                }
                event
            });
            let local_token: id = msg_send![class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: (1usize << 15)
                handler: RcBlock::as_ptr(&local).cast::<c_void>()];
            assert!(!local_token.is_null());
            let _: id = msg_send![local_token, retain];
            drop(global);
            drop(local);
            pool.drain();
            assert!(
                global_weak.upgrade().is_some(),
                "global callback must retain its state"
            );
            assert!(
                weak.upgrade().is_some(),
                "AppKit must own the captured state"
            );

            let pool = cocoa::foundation::NSAutoreleasePool::new(nil);
            // Application-defined event (15), confined to this private queue.
            let event: id = msg_send![class!(NSEvent), otherEventWithType: 15usize
                location: NSPoint::new(0.0, 0.0) modifierFlags: 0usize
                timestamp: 0.0f64 windowNumber: 0isize context: nil
                subtype: 0i16 data1: 7319isize data2: 0isize];
            app.postEvent_atStart_(event, YES);
            let deadline: id = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.1f64];
            let mode = cocoa::foundation::NSString::alloc(nil).init_str("kCFRunLoopDefaultMode");
            let mut received = false;
            for _ in 0..10 {
                let delivered = app.nextEventMatchingMask_untilDate_inMode_dequeue_(
                    1u64 << 15,
                    deadline,
                    mode,
                    YES,
                );
                if delivered.is_null() {
                    break;
                }
                let marker: isize = msg_send![delivered, data1];
                if marker == 7319 {
                    app.sendEvent_(delivered);
                    received = true;
                    break;
                }
            }
            let _: () = msg_send![mode, release];
            assert!(received, "local monitor must pass through our queued event");
            assert_eq!(weak.upgrade().unwrap().load(Ordering::Relaxed), 1);
            let _: () = msg_send![class!(NSEvent), removeMonitor: global_token];
            let _: () = msg_send![class!(NSEvent), removeMonitor: local_token];
            let _: () = msg_send![global_token, release];
            let _: () = msg_send![local_token, release];
            pool.drain();
            assert!(
                global_weak.upgrade().is_none(),
                "global callback must release its state"
            );
            assert!(
                weak.upgrade().is_none(),
                "removal must release captured state"
            );
        }
        outer.drain();
    }
    println!("AppKit callback lifetime: 50 install/deliver/remove cycles passed");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
