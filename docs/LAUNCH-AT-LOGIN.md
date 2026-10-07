# Launch at login

Settings → General → Startup contains the standard Launch at login switch.
Navigation search includes a specific setting target for startup, autostart,
boot, and open-at-login queries. Selecting it opens General, scrolls to the
row, and focuses the switch. Dictation now uses the `dictation` section ID;
`general` is the application preferences section.

## Native ownership and migration

`src-tauri/src/startup.rs` uses ServiceManagement's `SMAppService.mainAppService`
through objc2. macOS owns registration and authorization. The frontend service
and hook project its current status, refreshing on window focus so changes made
in System Settings are visible. Only the main window has the startup commands.

The shared settings store contains `launchAtLoginInitialized`, an initialization
marker rather than a cached enabled value. On an installed release's first
launch, an existing customer's completed onboarding triggers a one-time default
registration. Successful registration or an existing approval requirement saves
the marker. Later launches and upgrades read macOS without registering again.
Registration errors leave automatic migration retryable on the next app launch.

Fresh setup offers an initially checked switch on the existing Ready screen.
Finishing setup applies the choice once; permission recovery never overwrites
an initialized choice. Explicit choices save the marker before changing macOS,
so an unsuccessful operation cannot cause a later automatic migration to undo
an opt-out. An error leaves the displayed state confirmed by macOS and supports
retry. Startup configuration does not block finishing dictation setup.

The default only applies to release builds installed under `/Applications` or
the customer's `~/Applications`. Dev binaries, mounted installers, translocated
apps and retained build candidates cannot register as login items. The UI
explains when the app needs to be installed. The ServiceManagement API requires
a signed app; Linty's release signing provides that.

`requiresApproval` is shown as pending with an Open Login Items action and an
option to turn off the pending registration. It is never presented as enabled,
and we never unregister/reregister to circumvent a system-level denial.

## Launch and menu bar behavior

Tauri's setup runs in the native applicationDidFinishLaunching callback. It
captures the Apple event's login launch reason there, before displaying windows.
Activation is initially prohibited to avoid Tao's early activation; setup sets
Accessory for login launches and restores the main window for ordinary opens.
Login launches retain the normal WebView, dictation hooks, models and tray, but
leave the dashboard hidden. Dock, Spotlight, menu actions and second launches
still use the shared main-window restoration path.

The tray menu remains on left-click. Right-button release restores the main
window using Tauri's tray event handler and its public inner-icon API to disable
the default right-click menu. Tauri is pinned to the 2.11 minor series because
the public inner-icon API follows the underlying tray-icon version.

## Release and verification

The existing required-update flow installs and relaunches Linty; it does not
reboot macOS. Migration runs inside the new app, covering automatic updates,
manual updates and customers who skip versions. The normal local release
runbook supplies `--release-type required`; release tooling needs no new path.

Native unit tests cover disk-persisted upgrade migration, first setup, opt-outs,
external changes, pending approval, failed migration and installation paths.
WebKit checks cover direct search/focus, honest failed changes, system status
refresh, pending registration cancellation and first-setup default/opt-out.
Installed signed-app acceptance must check registration/unregistration, a login
Apple event, hidden launch, and both menu bar mouse buttons. Restarting the actual
Mac is a separate manual acceptance case.
