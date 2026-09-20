import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { useUpdater } from "@/hooks/useUpdater.hook";
import { ReleaseNotes } from "./ReleaseNotes.component";

/**
 * Blocking screen for a release marked required (latest.json
 * minimum_version). It cannot be dismissed; dictation keeps working until the
 * app restarts, which happens only after dictation has been quiet for a while.
 */
export function UpdateRequiredDialogue() {
  const updateRequired = useAppStore((s) => s.updateRequired);
  const status = useAppStore((s) => s.updateStatus);
  const progress = useAppStore((s) => s.updateProgress);
  const error = useAppStore((s) => s.updateError);
  const current = useAppStore((s) => s.updateCurrentVersion);
  const target = useAppStore((s) => s.updateVersion);
  const notes = useAppStore((s) => s.updateNotes);
  const { checkForUpdate } = useUpdater();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = updateRequired && status !== "idle" && status !== "available";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className="confirmation-dialog update-required-dialog"
      aria-labelledby="update-required-title"
      aria-describedby="update-required-message"
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dialog-icon"><RefreshCw size={24} /></div>
      <h2 id="update-required-title">Linty needs to update</h2>
      <p id="update-required-message">
        This version is no longer supported. Linty will install the latest version and restart.
      </p>
      {current && target && (
        <p className="update-versions">From version {current} to {target}</p>
      )}
      {notes && <section className="installed-release-notes" aria-label="What's new"><ReleaseNotes notes={notes} /></section>}

      <div className="update-step" role="status" aria-live="polite">
        {status === "checking" && <span>Checking for the update…</span>}
        {status === "downloading" && (
          <>
            <progress className="update-progress" max={100} value={progress} aria-label="Download progress" />
            <span>Downloading… {progress}%</span>
          </>
        )}
        {status === "waiting" && (
          <span>Downloaded. Linty restarts once you’ve finished dictating. You can keep dictating until then.</span>
        )}
        {status === "installing" && <span>Installing and restarting…</span>}
      </div>

      {status === "error" && (
        <>
          <p className="update-error" role="alert">{error ?? "The update could not be installed."}</p>
          <div className="dialog-actions">
            <button className="standard-button primary-button" onClick={() => checkForUpdate()}>
              Try again
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
