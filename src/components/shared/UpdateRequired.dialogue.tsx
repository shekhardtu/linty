import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { useUpdater } from "@/hooks/useUpdater.hook";
import { isDictationBusy } from "@/lib/force-update.util";
import { ReleaseNotes } from "./ReleaseNotes.component";

/**
 * Modeless notice: no backdrop, focus capture, or blocked window controls.
 * Dismissal hides presentation only; the updater owns installation/restart.
 */
export function UpdateRequiredDialogue() {
  const updateRequired = useAppStore((s) => s.updateRequired);
  const status = useAppStore((s) => s.updateStatus);
  const progress = useAppStore((s) => s.updateProgress);
  const error = useAppStore((s) => s.updateError);
  const current = useAppStore((s) => s.updateCurrentVersion);
  const target = useAppStore((s) => s.updateVersion);
  const notes = useAppStore((s) => s.updateNotes);
  const dismissed = useAppStore((s) => s.updateNoticeDismissed);
  const restartAt = useAppStore((s) => s.updateRestartAt);
  const restartPending = useAppStore((s) => s.updateRestartPending);
  const dictating = useAppStore(isDictationBusy);
  const [now, setNow] = useState(Date.now);
  const { checkForUpdate } = useUpdater();
  const open = updateRequired && !dismissed && !["idle", "available", "restarting"].includes(status);
  const dismiss = () => useAppStore.setState({ updateNoticeDismissed: true });

  useEffect(() => {
    if (!open || status !== "waiting" || restartAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, status, restartAt]);

  if (!open) return null;

  return (
    <dialog
      open
      className="confirmation-dialog update-required-dialog"
      aria-modal="false"
      aria-labelledby="update-required-title"
      aria-describedby="update-required-message"
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}
    >
      <div className="update-notice-heading">
        <RefreshCw size={20} aria-hidden="true" />
        <h2 id="update-required-title">Updating Linty</h2>
        <button className="icon-button" aria-label="Hide update notice" onClick={dismiss}><X size={16} aria-hidden="true" /></button>
      </div>
      <p id="update-required-message">
        {restartPending ? "The update is installed. Restart Linty to finish."
          : "This update installs automatically. You can keep using Linty while it downloads."}
      </p>
      {current && target && (
        <p className="update-versions">From version {current} to {target}</p>
      )}
      {notes && <details className="update-notice-notes"><summary>What’s new</summary><ReleaseNotes notes={notes} /></details>}

      <div className="update-step" role="status" aria-live="polite">
        {status === "checking" && <span>Checking for the update…</span>}
        {status === "downloading" && (
          <>
            <progress className="update-progress" max={100} value={progress} aria-label="Download progress" />
            <span>Downloading… {progress}%</span>
          </>
        )}
        {status === "waiting" && (
          <span>{dictating ? "Downloaded. Finish your dictation; Linty will restart afterward."
            : restartAt !== null ? `Downloaded. Restarting in ${Math.max(0, Math.ceil((restartAt - now) / 1000))} seconds…`
            : "Downloaded. Getting ready to restart…"}</span>
        )}
        {status === "verifying" && <span>Getting ready to restart…</span>}
        {status === "installing" && <span>Installing… Linty will restart automatically.</span>}
      </div>

      {status === "error" && (
        <>
          <p className="update-error" role="alert">{error ?? "The update could not be installed."}</p>
          <div className="dialog-actions">
            <button className="standard-button primary-button" onClick={() => checkForUpdate()}>
              {restartPending ? "Restart Linty" : "Try again"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
