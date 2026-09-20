import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { getPageDefinition, SETTINGS_SECTIONS } from "@/config/navigation.config";
import { MicrophoneTest } from "@/components/MicrophoneTest.component";

export function RecordingFocus() {
  const open = useAppStore(s => s.recordingFocusOpen);
  return open ? <RecordingFocusDialog /> : null;
}

function RecordingFocusDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { currentView, settingsSection, isRecording, status, setRecordingFocusOpen } = useAppStore();
  const busy = isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(status);
  const hasRecorded = useRef(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [stay, setStay] = useState(false);
  const origin = useRef(currentView === "settings"
    ? SETTINGS_SECTIONS.find(section => section.id === settingsSection)!.label
    : getPageDefinition(currentView).label).current;

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      dialog.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (busy) {
      hasRecorded.current = true;
      setRemaining(null);
      setStay(false);
      return;
    }
    if (!hasRecorded.current || stay) return;
    const deadline = Date.now() + 10_000;
    setRemaining(10);
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) setRecordingFocusOpen(false);
    }, 250);
    return () => clearInterval(timer);
  }, [busy, stay, setRecordingFocusOpen]);

  return (
    <dialog ref={dialogRef} className="recording-focus" aria-label="Focused dictation" tabIndex={-1}
      onCancel={event => { event.preventDefault(); if (!busy) setRecordingFocusOpen(false); }}>
      <header className="recording-focus-toolbar" data-tauri-drag-region>
        <button className="standard-button" disabled={busy} onClick={() => setRecordingFocusOpen(false)} title={busy ? "Finish your recording to return" : undefined}>
          <ArrowLeft size={15} aria-hidden="true" />Back to {origin}
        </button>
        <span data-tauri-drag-region>Linty · Dictation</span>
      </header>
      <div className="recording-focus-content">
        <MicrophoneTest focused />
      </div>
      <footer className="recording-focus-return">
        <p>{busy ? "Take your time. The return countdown starts when your recording is finished."
          : stay ? "Stay as long as you like. Your transcripts are here until you go back."
          : remaining !== null ? <>Returning to {origin} in <span className="recording-focus-countdown">{remaining}s</span></>
          : "Your previous screen is right where you left it."}</p>
        {!busy && remaining !== null && !stay && <div>
          <button className="standard-button" onClick={() => setStay(true)}>Stay here</button>
          <button className="standard-button" onClick={() => setRecordingFocusOpen(false)}>Back now</button>
        </div>}
      </footer>
    </dialog>
  );
}
