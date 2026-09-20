# Get help with Linty

Linty runs on **macOS 14 or later, on Intel and Apple silicon Macs**. One universal installer supports both processors. Intel Macs use Whisper dictation and CPU-based S1-mini cleanup; Parakeet is available on Apple silicon. Windows, Linux, iPhone, and iPad are not supported by this desktop app.

## Install and try your first dictation

1. [Download Linty for Mac](https://github.com/shekhardtu/linty/releases/latest/download/linty.dmg).
2. Open the `.dmg` file and drag **Linty** into **Applications**. Open Linty from Applications.
3. English and **Right Command (⌘)** are selected automatically. In System Check, allow Microphone and Accessibility access so Linty can hear you and paste into other apps. The guided setup is optional; no language or shortcut choice is required.
4. Keep an internet connection while Linty prepares your language. Speech support downloads are about 500–574 MB. English also prepares on-device text cleanup (about 496 MB). Downloads are reused; dictation works offline once setup is ready.
5. Optionally choose **Start recording** in System Check. Speak a short sentence and choose **Stop & transcribe**. Test transcripts are saved in History and can be deleted there.
6. Open Notes or another app and click in an editable text field. Hold **Right Command**, speak, and release to paste. To dictate hands-free, double-press your trigger, then press once to finish. Change your trigger in **Shortcuts** or your language in **Settings → Dictation**. Existing customers keep their saved preferences.

Official releases are signed and notarized by Apple. No account, API key, or subscription is required.

## Linty cannot hear me

- Open **Settings → Audio** and check the input device. Choose **Test your microphone** to open System Check.
- In **System Settings → Privacy & Security → Microphone**, turn on Linty. Return to Linty after changing the permission.
- If your selected microphone was disconnected, choose another device or **System Default**.
- Try a short sentence close to the microphone, away from background noise.

## My words do not appear in another app

1. Open **History**. If the transcript is there, choose **Copy** and paste it yourself.
2. In **System Check**, check Accessibility access. Open **System Settings → Privacy & Security → Accessibility** and enable Linty.
3. Click inside an editable text field in the destination app, then try again. Some text fields cannot receive automatic paste.
4. If **fn** also opens macOS dictation or the emoji picker, follow Linty’s shortcut warning or choose another trigger in **Shortcuts**.

If macOS already shows the permission enabled but Linty cannot use it, toggle it off and on. For persistent Accessibility problems, remove Linty from that list, add it again from Applications, and enable it.

## My language is still preparing

Keep Linty open and connected while the first download completes. If preparation fails, use **Retry preparation**. In setup, **Change language** returns to your language choice. Later, use **Settings → Dictation**.

Changing languages may require another download. A previously configured language stays active until the new one is ready. Avoid deleting your data or models as a first troubleshooting step.

## A transcription needs correcting

Choose the language you are speaking in **Settings → Dictation**. For **Auto-detect**, select and save one to three languages. App menus remain in English, and accuracy varies by language and recording conditions.

Use **History → Edit text** to fix a transcript. Add names and specialist terms in **Dictionary**. Suggestions from corrections can be reviewed there. If English cleanup changes wording you wanted to keep, select **Keep as spoken** in Settings → Dictation.

## Update, export, or remove saved data

- **About → Check for updates** checks for a newer release. If a download fails, reconnect and retry. [Release notes](https://github.com/shekhardtu/linty/releases) explain what changed.
- **Settings → Privacy & storage** contains history export, retention, deletion, and the opt-in setting for saving dictation audio.
- Deleting history also removes its recordings and statistics. Export anything you want to keep first.

Read the [privacy notice](PRIVACY.md) for storage and network details.

## Still need help?

[Report a bug](https://github.com/shekhardtu/linty/issues/new?template=bug_report.yml) with your Linty version (in About), Mac and macOS version, spoken language, destination app, and steps to reproduce. Use made-up example text. GitHub reports are public and require sign-in; do not include private transcripts, recordings, or credentials.

[Request a feature](https://github.com/shekhardtu/linty/issues/new?template=feature_request.yml) or [join a discussion](https://github.com/shekhardtu/linty/discussions). For security issues, use [private vulnerability reporting](https://github.com/shekhardtu/linty/security/advisories/new).
