import { useSyncExternalStore } from "react";
import { AlertCircle, Check, Download, Loader2, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { languagePreparation, prepareLanguage } from "@/services/language-preparation.service";
import { languageLabel } from "@/lib/languages.util";

export function LanguageReadiness() {
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);
  const { transcriptionLanguage, loadedModelFilename } = useAppStore();
  const ready = preparation.status === "ready" || (preparation.status === "idle" && !!loadedModelFilename);
  const failed = preparation.status === "error" || preparation.status === "unavailable";
  const language = languageLabel(preparation.language ?? transcriptionLanguage);
  const title = failed ? "Speech support needs attention"
    : ready ? "Ready for offline dictation"
    : preparation.status === "downloading" ? "Downloading speech support"
    : preparation.status === "waiting" ? "Waiting for your dictation to finish"
    : `Preparing ${language === "Auto-detect" ? "automatic language detection" : language}…`;
  return <div className={`language-readiness ${failed ? "has-error" : ""}`}>
    <div className="language-readiness-heading" role="status" aria-live="polite">
      {failed ? <AlertCircle size={17} /> : ready ? <Check size={17} /> : preparation.status === "downloading" ? <Download size={17} /> : <Loader2 size={17} className="animate-spin" />}
      <strong>{title}</strong>
    </div>
    <p role={failed ? "alert" : undefined}>{failed ? preparation.error
      : ready ? "Your speech is transcribed on this Mac. No internet connection needed."
      : preparation.status === "downloading" ? `A one-time download${preparation.model ? ` · about ${preparation.model.size_mb} MB` : ""}. Other languages can share this speech support.`
      : "Linty chooses and prepares speech support automatically."}</p>
    {preparation.status === "downloading" && <div className="language-download-progress">
      <progress aria-label="Speech support download" max={100} value={preparation.progress} /><span>{preparation.progress}%</span>
    </div>}
    {preparation.language && preparation.language !== transcriptionLanguage && <p className="language-pending-note">
      {languageLabel(transcriptionLanguage)} remains active until {language} is ready.
    </p>}
    {failed && preparation.status !== "unavailable" && <button className="text-link" onClick={() => { void prepareLanguage(preparation.language ?? transcriptionLanguage).catch(() => {}); }}><RefreshCw size={13} />Retry preparation</button>}
  </div>;
}
