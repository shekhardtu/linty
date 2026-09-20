import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/store/app.store";
import { acknowledgeUpdate } from "@/services/update-acknowledgment.service";
import { isDictationBusy } from "@/lib/force-update.util";
import { installedReleaseNotes, ReleaseNotes, releaseUrl } from "./ReleaseNotes.component";

export function UpdateAcknowledgmentDialogue({ paused }: { paused: boolean }) {
  const notice = useAppStore(s => s.updateNotice);
  const required = useAppStore(s => s.updateRequired);
  const status = useAppStore(s => s.updateStatus);
  const checkedAt = useAppStore(s => s.updateCheckedAt);
  const dictating = useAppStore(isDictationBusy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const visible = Boolean(notice) && !required && !dictating && !paused
    && !["downloading", "waiting", "installing"].includes(status);

  useEffect(() => {
    if (!visible || !dialog.current) return;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    done.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [visible]);

  const dismiss = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await acknowledgeUpdate();
      useAppStore.setState({ updateNotice: null });
    } catch {
      setError("Could not save your acknowledgment. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!visible || !notice) return null;
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog update-acknowledgment-dialog"
      aria-labelledby="update-acknowledgment-title"
      aria-describedby="update-acknowledgment-description"
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }}
      onCancel={event => { event.preventDefault(); void dismiss(); }}
    >
      <div className="dialog-icon"><CheckCircle2 size={28} aria-hidden="true" /></div>
      <h2 id="update-acknowledgment-title">{notice.kind === "updated" ? "Linty updated" : "What's new in Linty"}</h2>
      <p id="update-acknowledgment-description">Version {notice.version} is installed.</p>
      <p className="installed-update-status" role="status">
        {status === "idle" && checkedAt !== null ? "You’re up to date."
          : status === "checking" ? "Checking for updates…"
          : status === "available" ? "Another update is available in About."
          : "You can keep using Linty."}
      </p>
      <section className="installed-release-notes" aria-label="What's new">
        <h3>What improved</h3>
        <ReleaseNotes notes={installedReleaseNotes(notice.version)} />
      </section>
      {error && <p className="update-acknowledgment-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="standard-button" onClick={() => {
          void open(releaseUrl(notice.version)).catch(() => setError("Could not open the release notes. Please try again."));
        }}>View release notes</button>
        <button ref={done} className="standard-button primary-button" disabled={saving} onClick={() => void dismiss()}>
          {saving ? "Saving…" : "Got it"}
        </button>
      </div>
    </dialog>
  );
}
