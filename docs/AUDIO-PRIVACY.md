# Dictation audio privacy

Saving dictation audio is **off by default**, including for existing installations. Settings → Privacy & storage → **Save dictation audio** is an explicit choice to retain future recordings locally. The microphone is still used to transcribe when saving is off.

When enabled before a dictation begins, Linty can attach the recording to its saved transcript. You can listen in History, export a WAV file, or delete just the recording. Older dictations cannot gain audio retroactively. Cancelled dictations, empty results, and failed transcription attempts do not create saved recordings. A successful transcription can retain its audio even if pasting into another app fails.

Recordings are stored with history on your Mac, as 16 kHz mono PCM16 WAV data inside `linty-history.sqlite3` (about 2 MB per minute). Audio is not included in logs or sent to Linty. This archive is not separately encrypted by the app; the same device access and backup protections as your transcript history apply.

History loads a recording when you select its transcript, so the player is ready without an extra loading step. Playback starts only when you press Play. In-app playback is limited to 64 MiB (about 35 minutes) to bound memory use. Larger recordings remain saved and can be exported as WAV for listening outside Linty. Leaving the recording stops playback, cancels pending reads, and releases its playback data.

Turning saving off stops retention of new audio, including audio still being processed. Previously saved recordings remain until deleted. The preference is checked at both capture and save; turning it off and back on cannot authorize an earlier recording.

Recordings follow the history retention period: until deleted by default, or 30 days, 90 days, or 1 year. Automatic cleanup runs at most once every 24 hours, including while the window is hidden. The schedule survives restarts. Launch, wake, and history access check whether that daily cleanup is due; they do not trigger extra sweeps within the interval. Expired entries can remain until the next cleanup, or the next launch/wake if Linty is closed or the Mac is asleep. Applying a retention setting removes already-expired entries immediately and starts a new daily interval.

Cleanup runs only within Linty. It installs no system background service, cannot launch Linty or wake the Mac, and stops when you choose **Quit Linty**. Closing the main window keeps the app running in the menu bar for dictation; its daily cleanup can still run in that state.

Deleting a transcript immediately removes its recording and associated corrections in the same transaction; Undo restores text and corrections only. Deletion and expiry stop loaded playback and release its cached audio data, including if a subsequent history refresh fails. History's audio controls can delete one or all recordings without deleting text. Clear history and Reset All Data remove saved recordings too. Deleted database space is cleared and reused; the archive file does not automatically shrink. Copies in exports or device backups are outside these deletion controls. Your dictionary and downloaded speech models are separate from an individual dictation and remain available.

History JSON export includes transcript text and metadata, but not audio bytes. **Export WAV…** uses a native save dialog for the selected recording. The suggested filename includes its transcript ID so you can match the audio to your history export. You choose where that copy goes; exporting to a synced folder may sync it through your own storage provider.

Saving locally does **not** grant permission to share recordings, train models, or run automatic evaluations. Saved audio and its associated transcript/model metadata can support evaluations you choose to perform later. Any future feature that uploads recordings or uses them automatically for evaluations or training must obtain a separate, specific opt-in.

Speech recognition and optional text cleanup run on this Mac. The audio-saving preference controls only local retention; dictation does not upload audio or text.
