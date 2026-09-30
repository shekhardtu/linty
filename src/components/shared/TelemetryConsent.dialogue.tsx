import { useEffect, useRef, useState } from "react";
import { TelemetryChoice } from "@/components/settings/TelemetryPreferences.component";
import { saveTelemetry, useTelemetry } from "@/services/telemetry.service";
import { useAppStore } from "@/store/app.store";
import { isDictationBusy } from "@/lib/force-update.util";

/** One heads-up when an existing installation first receives telemetry. */
export function TelemetryConsentDialogue({ paused }: { paused: boolean }) {
  const { loaded, available, decided, saving } = useTelemetry();
  const busy = useAppStore(isDictationBusy);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const visible = loaded && available && !decided && !paused && !busy;
  useEffect(() => {
    if (!visible || !dialog.current) return;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    confirm.current?.focus({ preventScroll: true });
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [visible]);
  const save = async () => {
    setError("");
    try { await saveTelemetry(enabled); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save your choice. Please retry."); }
  };
  if (!visible) return null;
  return <dialog ref={dialog} className="confirmation-dialog telemetry-consent-dialog"
    aria-labelledby="telemetry-consent-title" aria-describedby="telemetry-consent-description"
    onCancel={event => event.preventDefault()}>
    <h2 id="telemetry-consent-title">Help improve Linty</h2>
    <p id="telemetry-consent-description">Linty now offers optional telemetry. Please confirm your choice. Nothing is sent before confirmation.</p>
    <TelemetryChoice enabled={enabled} onChange={setEnabled} disabled={saving} />
    {error && <p role="alert" className="text-error text-[12px]">{error}</p>}
    <div className="dialog-actions">
      <button ref={confirm} className="standard-button primary-button" disabled={saving} onClick={() => { void save(); }}>
        {saving ? "Saving…" : "Confirm preference"}
      </button>
    </div>
  </dialog>;
}
