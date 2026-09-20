# Microphone selection

Left-click or right-click the Linty menu bar icon to open the same native menu.
Choose **Microphone** to select an input. **Open Linty** opens the application.
**Language · Auto-detect** (or the selected language) opens a checked native
submenu with the same supported languages as Settings. Changing either view
updates the other and saves the preference. Language changes are disabled during
dictation; a failed save retains the previous choice. The language list is sent
from the existing frontend catalog, so native code does not maintain a duplicate.
The native menu groups dictation controls, transcription actions, and app
controls with standard separators. **Recent Transcriptions** contains the last
five previews and **View History…**. **Copy Last Transcription** copies the full
record directly; deleted or edited records are resolved from storage at click time.

The tray shows **On-device · Ready** when speech support is prepared, the app is
idle, and a microphone is available. A quiet shortcut hint replaces the old Ready
row; recording and processing retain their activity labels. Language selection and
Quit are disabled during dictation/processing. macOS owns the menu's appearance,
keyboard navigation, dismissal, checkmarks and submenus. There is no tray webview.
The monochrome three-stroke icon is a native template, generated from the same
source as the app icon with `yarn icons:generate`. See [Brand icons](BRAND-ICONS.md).

- **System Default** follows the microphone selected in macOS. Its current name
  appears in the submenu. Choosing another input affects Linty only.
- A specific microphone is remembered across restarts. Audio settings and the
  menu use the same native preference and update each other immediately.
- Device lists refresh every three seconds without opening a recording stream.
  An unplugged selection remains visible as unavailable; Linty asks for another
  input instead of silently recording through a different microphone.
- Input selection is disabled during recording and enforced by the backend.
  Startup waits for the selected microphone to open before reporting success;
  a quick key release waits for startup before stopping capture.
- CPAL 0.15 identifies selectable devices by name. If multiple devices have an
  identical name, select System Default and choose the device in macOS. Linty
  does not persist an unstable list index or choose an arbitrary matching device.
- Reset All Data restores System Default.

Native policy tests cover unavailable/ambiguous devices and selection during
capture. Browser tests cover Settings/tray event synchronization, persistence
requests, failed saves, disconnected selections, and recording lockout in both
themes, plus failed startup and release while startup is pending. Native macOS
inspection verified the engine indicator, microphone list, selection, and
persistence across an app restart. Physical Bluetooth/USB unplugging and
microphone permission changes remain device-dependent checks.
