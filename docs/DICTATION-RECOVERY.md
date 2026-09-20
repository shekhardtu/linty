# Dictation recovery

## Behavior

- Startup, stop, configuration, and inference errors replace the spinner with an
  explanation in the capsule. Errors dismiss after six seconds. Empty recordings
  return to idle; no transcription spinner is started for zero samples.
- Recording becomes visible only after the microphone opens successfully. A quick
  key release waits for startup. The hotkey and System Check share startup state.
- Microphone disconnection cancels the active attempt and resets capture. The
  native watchdog also detects eight seconds of missing audio callbacks (ordinary
  silence still produces callbacks). Next recording opens a fresh audio stream.
- Startup is bounded to ten seconds in the frontend (eight seconds for native
  device opening); stop and routine IPC waits to five seconds. Transcription has
  at least sixty seconds, scaling to twice the recording duration plus thirty
  seconds. Active recording duration remains unlimited. The [quiet-input safeguard](DICTATION-PILL.md) warns after 20 seconds without input activity and closes capture at 30 seconds.
- Cancelled sessions cannot resume the frontend pipeline and paste late inference
  results. Audio generations prevent abandoned capture from writing into the next
  recording and prevent cancelled Whisper progress from changing its capsule.
- Language changes prepare the matching local model and wait for active dictation to finish. Recovery never uploads speech or automatically retries transcription.

## Process crashes

An exited process needs a separate supervisor. For the local development app:

```sh
python3 scripts/run-recoverable.py -- src-tauri/target/debug/linty
```

Keep the Vite development server running for that binary. The runner restarts
nonzero/crash exits with 1/2/4-second backoff, at most three restarts in sixty
seconds. Normal Quit, SIGTERM, and SIGINT stay quit. No login service is installed.
Use the supervisor's PID to stop both it and its child. Its log goes to stderr.
The same runner can wrap an installed app's executable, but it is not bundled as
an automatic production login/crash service.

This does not promise recovery from every failure: a frozen macOS main thread or
hung native inference cannot be forcibly unwound safely by a JavaScript timeout.
The UI can abandon a pending result while its native task is still running. Full
hard-hang isolation needs inference in a killable child process and an external
heartbeat watchdog. Unfinished audio remains in memory and is not preserved over
a restart. The recovery path discards the failed capture rather than pasting it
later into a different application.

## Validation

- `node tests/ui.recovery.mjs` (also with `UI_BROWSER=webkit`): errors in the capsule, empty audio, quick
  release, microphone disconnect, hung startup/inference, successful retry, and
  suppression of a late result.
- `python3 tests/supervisor.test.py`: clean quit, one crash followed by recovery,
  bounded crash loop, and intentional termination.
- `cargo test --features local-stt,parakeet --lib`, frontend type/build checks, and
  the existing UI smoke suite.

The failure cases above use injected IPC/device events and a controlled clock.
They do not claim a physical unplug or an actual production binary crash test.
