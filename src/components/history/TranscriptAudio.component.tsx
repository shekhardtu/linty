import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/app.store";
import { deleteSavedAudio, exportSavedAudio, getSavedAudio } from "@/services/history.service";
import { ConfirmActionDialogue } from "@/components/shared/ConfirmAction.dialogue";
import type { TranscriptRecord } from "@/types/transcript.types";
import { MAX_AUDIO_PLAYBACK_BYTES } from "@/lib/history-audio";

export function TranscriptAudio({ transcript }: { transcript: TranscriptRecord }) {
  const openPrivacy = () => {
    const state = useAppStore.getState();
    state.setSettingsSection("privacy");
  };
  if (!transcript.audio) return (
    <div className="dictation-audio audio-not-saved">
      <span>No saved audio for this dictation.</span>{" "}
      <button type="button" className="text-link" onClick={openPrivacy}>Audio privacy settings</button>
    </div>
  );
  return <SavedAudio key={transcript.transcriptId} id={transcript.transcriptId} bytes={transcript.audio.bytes} />;
}

function SavedAudio({ id, bytes }: { id: string; bytes: number }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const notify = useAppStore((s) => s.addToast);
  const tooLarge = bytes > MAX_AUDIO_PLAYBACK_BYTES;

  useEffect(() => {
    setFailed(false);
    setUrl(undefined);
    if (bytes > MAX_AUDIO_PLAYBACK_BYTES) return;
    const controller = new AbortController();
    let stale = false;
    let objectUrl: string | undefined;
    void getSavedAudio(id, bytes, controller.signal).then((blob) => {
      if (stale) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (!stale) setFailed(true); });
    return () => {
      stale = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, bytes, retry]);

  useEffect(() => {
    const audio = player.current;
    if (!audio) return;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [url]);

  const exportAudio = async () => {
    setBusy(true);
    try {
      if (await exportSavedAudio(id)) notify({ type: "success", message: "Audio exported as WAV." });
    } catch {
      notify({ type: "error", message: "Could not export this recording. Please try again." });
    } finally { setBusy(false); }
  };
  const removeAudio = async () => {
    setBusy(true);
    try {
      await deleteSavedAudio(id);
      setConfirmDelete(false);
      notify({ type: "success", message: "Recording deleted. Your transcript was kept." });
    } catch {
      notify({ type: "error", message: "Could not delete this recording. Please try again." });
    } finally { setBusy(false); }
  };

  return (
    <section className="dictation-audio" aria-label="Dictation audio">
      <div className="audio-heading"><h3>Recording</h3></div>
      {tooLarge && <p>For this long recording, export the WAV to listen without loading it into Linty.</p>}
      {url && <audio ref={player} controls preload="metadata" src={url} aria-label="Play dictation recording" onError={() => setFailed(true)} />}
      {!tooLarge && (failed ? <p role="alert">Could not load this recording. <button type="button" className="text-link" onClick={() => setRetry((n) => n + 1)}>Retry audio</button></p>
        : !url && <p role="status">Loading recording…</p>)}
      <div className="audio-actions">
        <button type="button" className="standard-button" disabled={busy} onClick={() => void exportAudio()}>Export WAV…</button>
        <button type="button" className="text-link" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete recording…</button>
      </div>
      <ConfirmActionDialogue open={confirmDelete} busy={busy} title="Delete this recording?"
        description="This permanently deletes the saved audio. Your transcript and corrections are kept. This cannot be undone."
        confirmLabel="Delete recording" onCancel={() => setConfirmDelete(false)} onConfirm={() => void removeAudio()} />
    </section>
  );
}
