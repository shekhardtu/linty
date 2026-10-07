# Launch at login acceptance

Date: 2026-10-08. Source: feature branch `feat/launch-at-login`.

## Installed native candidate

A Developer ID signed Apple-silicon candidate with version 0.0.9 was installed
temporarily at `/Applications/Linty.app`. The original 0.0.8 app was preserved
and restored after checks. Customer history and preferences were preserved.

- Native initialization enabled launch at login for the existing installation
  and saved the one-time marker.
- Search for startup selected Launch at login and opened General.
- Turning the switch off unregistered the login item. After quitting and
  launching again, General still showed it off; migration did not re-enable it.
- Turning it on registered the service again and showed the confirmed enabled
  state. It was left enabled as requested.
- Ordinary native launch displayed the app. Dictation remained usable during
  acceptance; no microphone or Accessibility grants were changed.

Acceptance caught a real platform edge: macOS can report `NotFound` before the
main-app login service has its first record, even for an installed signed app.
That state is off and permits registration; it must not disable the setting as
if the app were running from a mounted installer. The corrected candidate passed
the registration and persistence checks above.

## Automated evidence

- Frontend production build and Rust checks with both local-stt and
  local-stt/parakeet feature sets passed.
- Six native startup tests passed, including persisted upgrade migration,
  opt-outs, external changes, pending approval, failed operations, eligible
  installation paths, and real Foundation Apple-event descriptors.
- All 210 Node tests passed, along with dependency-notice, security-advisory,
  Rust-formatting and logging checks.
- WebKit settings, onboarding, microphone and usability suites passed. Startup
  coverage includes direct search/focus, default-on setup, opt-out, setup retries,
  honest failed operations, external status refresh and pending cancellation.

The Mac was not rebooted during acceptance. Login-event classification was
tested with native descriptors; the hidden-launch branch was reviewed against
Tao/Tauri's applicationDidFinishLaunching setup timing. Physical left/right
menu bar clicks were not driven by the available app-window UI surface. The
tray uses the public right-click menu setting and right-button-release event;
its code compiled in the signed candidate.

The official release additionally runs the complete local validation and both
native architecture suites, builds the universal app, signs and notarizes it,
and verifies the updater signature and published asset hashes before cleanup.
