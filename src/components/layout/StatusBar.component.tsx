import { useSyncExternalStore } from "react";
import { AlertCircle, AudioLines, Check, Cpu, HardDrive, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { settingsSaveFeedback } from "@/lib/settings-save-feedback";
import { dictationPreparation } from "@/services/dictation-preparation.service";
import { AUTO_LANGUAGE, modelSupportsLanguage, validAutoDetectLanguages } from "@/lib/languages.util";

export function StatusBar() {
  const { status, isRecording, error, loadedModelFilename, transcriptionLanguage, autoDetectLanguages, setSettingsSection, currentView } = useAppStore();
  const saveStatus = useSyncExternalStore(settingsSaveFeedback.subscribe, settingsSaveFeedback.getSnapshot);
  const preparation = useSyncExternalStore(dictationPreparation.subscribe, dictationPreparation.getSnapshot);
  const showAboutCredit = currentView === "about" && (saveStatus === "idle" || saveStatus === "saved");
  const saveLabel = saveStatus === "saving" ? "Saving changes…" : saveStatus === "saved" ? "Changes saved locally" : saveStatus === "error" ? "Couldn't save changes. Try again." : "Changes are saved locally";
  const recording = isRecording || status === "recording";
  const preparing = status === "preparing" || preparation === "preparing";
  const busy = preparing || ["transcribing", "correcting", "pasting"].includes(status);
  const needsLanguages = transcriptionLanguage === AUTO_LANGUAGE && !validAutoDetectLanguages(autoDetectLanguages);
  const ready = !needsLanguages && preparation === "ready" && modelSupportsLanguage(loadedModelFilename, transcriptionLanguage);
  const engineState = recording ? "recording" : busy ? "processing" : status === "error" || !ready ? "unavailable" : "ready";
  const engine = "On-device";
  const labels: Record<string, string> = { transcribing: "Transcribing", correcting: "Refining text", pasting: "Pasting" };
  const activity = recording ? "Recording" : preparing ? "Preparing" : busy ? labels[status] : status === "error" ? "Error" : !ready ? "Not ready" : "Ready";
  const detail = status === "error" ? error || "Transcription failed"
    : preparation === "error" ? "Preparation failed. Try dictating again."
    : needsLanguages ? "Choose one to three languages in Dictation settings"
    : !ready && !recording && !busy ? loadedModelFilename ? "Dictation will prepare while you speak" : "Prepare dictation in Dictation settings"
    : activity;
  return (
    <footer className="status-bar">
      {showAboutCredit ? <p className="status-save">Made with care.</p> : <div className={`status-save is-${saveStatus}`} role="status" aria-atomic="true" title={saveLabel}>
        <span className="status-save-indicator" aria-hidden="true">
          <HardDrive size={13} className={saveStatus === "idle" ? "is-active" : ""} />
          <Loader2 size={13} className={saveStatus === "saving" ? "is-active animate-spin" : ""} />
          <Check size={13} className={saveStatus === "saved" ? "is-active" : ""} />
          <AlertCircle size={13} className={saveStatus === "error" ? "is-active" : ""} />
        </span>
        <span>{saveLabel}</span>
      </div>}
      <div className="status-engine-region" role="status" aria-atomic="true">
        <button className={`status-engine is-${engineState}`} onClick={() => setSettingsSection("general")}
          aria-label={`${engine}: ${activity}. Configure dictation language`} title={`${engine}: ${detail}`}>
          <span className="status-engine-indicator" aria-hidden="true">
            <Cpu size={13} className={engineState === "ready" ? "is-active" : ""} />
            <AlertCircle size={13} className={engineState === "unavailable" ? "is-active" : ""} />
            <AudioLines size={13} className={recording ? "is-active status-recording-icon" : ""} />
            <Loader2 size={13} className={engineState === "processing" ? "is-active animate-spin" : ""} />
          </span>
          <span>{engine}</span>
        </button>
      </div>
    </footer>
  );
}
