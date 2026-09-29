# Graceful update and restart

## Observed problem

The required-update UI used `showModal()` with cancellation prevented, covered
the app with a backdrop, and waited for 30 uninterrupted quiet seconds without
displaying that delay. Continued dictation restarted the wait. This looked like
a frozen app and left no way to dismiss the update screen.

On the reported Mac, the installed bundle and startup log confirmed version
0.0.6 started automatically after the final dictation. This established that the
reported flow eventually installed and restarted; no native deadlock was
confirmed. The unresponsive presentation and invisible waiting period were real.

## Behavior

- Required updates display a compact modeless notice. No backdrop or automatic
  focus movement. Hide or Escape within the notice dismisses it; Update status
  in the footer reopens it. Dismissal never cancels the update.
- Downloading does not prevent dictation or navigation. Installation waits for
  recording, transcription, correction, and paste to finish, then displays a
  five-second countdown. New dictation cancels that countdown.
- The pre-install release check has the same bounded timeout as other update
  checks, with a separate visible preparation state. A timeout retains the
  previously verified required update. Any late native resource is closed.
- A final synchronous claim protects dictation begun during the release check.
  Recording marks itself preparing before asynchronous dictionary initialization.
- Installation closes the notice and requests relaunch immediately. The
  restarting state prevents another installation or a new recording. A restart
  error provides a restart-only retry instead of downloading/installing again.
- Countdown rendering uses one one-second interval only while its notice and
  countdown are visible. No new polling service, telemetry, or customer-file
  cleanup is introduced.

[Modeless dialog semantics](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/show)
allow interaction with the surrounding page; the implementation renders an open
dialog without invoking modal presentation.

## Validation

WebKit tests exercise navigation and retained focus while the notice is open,
Hide/Escape/reopen, both themes, 640×480 layout and accessibility, waiting during
recording and paste, countdown cancellation by new dictation, exactly one
download/install/relaunch after hiding, restart-only retry, stalled release
rechecks, late-resource cleanup, and required/optional relaunch acknowledgment.
The existing broader UI and dictation suites also pass. Native updater code and
signed archive verification are unchanged; the customer Mac's successful 0.0.6
restart is supporting diagnostic evidence, not a test of this unreleased UI.
