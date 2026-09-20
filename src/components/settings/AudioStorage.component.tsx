import { useState } from "react";
import { Info } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { deleteSavedAudio, setSaveAudio } from "@/services/history.service";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { Toggle } from "@/components/shared/Toggle.component";
import { ConfirmActionDialogue } from "@/components/shared/ConfirmAction.dialogue";

export function AudioStorage() {
  const { saveAudio = false, audioCount = 0, audioBytes = 0 } = useAppStore((s) => s.historySnapshot);
  const ready = useAppStore((s) => s.historyLoaded && !s.historyError);
  const notify = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const audioSize = audioBytes < 1_000_000
    ? `${Math.ceil(audioBytes / 1000).toLocaleString()} KB`
    : `${(audioBytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  const changeConsent = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setSaveAudio(enabled);
      notify({ type: "success", message: enabled ? "Audio will be saved for new dictations." : "Audio saving is off. Existing recordings are kept until you delete them." });
    } catch {
      notify({ type: "error", message: "Could not save your audio preference. Please try again." });
    } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await deleteSavedAudio();
      setConfirmDelete(false);
      notify({ type: "success", message: "Saved recordings deleted. Your transcripts were kept." });
    } catch {
      notify({ type: "error", message: "Could not delete saved recordings. Please try again." });
    } finally { setBusy(false); }
  };
  return <>
    <SectionCard>
      <Toggle label="Save dictation audio" enabled={saveAudio} disabled={!ready || busy} onChange={(enabled) => void changeConsent(enabled)}
        description="Keep recordings of new dictations on this Mac so you can listen in History or export them for your own evaluations. Off by default. No automatic sharing or use for training or evaluations." />
      <aside className="audio-storage-info" aria-labelledby="saved-recordings-heading">
        <Info className="audio-storage-info-icon" size={18} aria-hidden="true" />
        <div className="audio-storage-info-content">
          <h3 id="saved-recordings-heading">Saved recordings</h3>
          <dl className="audio-storage-stats">
            <div><dt>Recordings</dt><dd>{audioCount.toLocaleString()}</dd></div>
            <div><dt>Storage used</dt><dd>{audioSize}</dd></div>
          </dl>
          <p>Recordings follow your history retention period and are deleted with their transcripts. Turning saving off keeps existing recordings.</p>
          <p className="audio-storage-estimate">About 2 MB per minute of audio.</p>
        </div>
      </aside>
      <div className="history-storage-actions">
        <button type="button" className="standard-button destructive-button" disabled={!ready || busy || !audioCount} onClick={() => setConfirmDelete(true)}>Delete all recordings…</button>
      </div>
    </SectionCard>
    <ConfirmActionDialogue open={confirmDelete} busy={busy} title="Delete all saved recordings?"
      description={`This permanently deletes ${audioCount.toLocaleString()} recordings and discards audio from any dictation being processed. Your transcripts and corrections are kept. New recordings will still be saved if audio saving is on. Copies you exported are unaffected.`}
      confirmLabel="Delete all recordings" onCancel={() => setConfirmDelete(false)} onConfirm={() => void clear()} />
  </>;
}
