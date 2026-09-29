import { useSyncExternalStore } from "react";
import { AlertCircle, Check, Download, Loader2, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { languagePreparation, prepareLanguage } from "@/services/language-preparation.service";
import { AUTO_LANGUAGE, languageLabel, validAutoDetectLanguages } from "@/lib/languages.util";

export function LanguageReadiness({ compact = false }: { compact?: boolean }) {
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);
  const { transcriptionLanguage, autoDetectLanguages, loadedModelFilename } = useAppStore();
  const ready = preparation.status === "ready" || (preparation.status === "idle" && !!loadedModelFilename);
  const needsLanguages = ready && (preparation.language ?? transcriptionLanguage) === AUTO_LANGUAGE && !validAutoDetectLanguages(autoDetectLanguages);
  const failed = preparation.status === "error" || preparation.status === "unavailable";
  const compactReady = compact && ready && !needsLanguages && !failed && (!preparation.language || preparation.language === transcriptionLanguage);
  const language = languageLabel(preparation.language ?? transcriptionLanguage);
  const cleanup = preparation.resource === "cleanup";
  const title = failed ? cleanup ? "Text cleanup needs attention" : "Speech support needs attention"
    : needsLanguages ? "Choose your Auto-detect languages"
    : ready ? "Ready for offline dictation"
    : preparation.status === "downloading" ? cleanup ? "Downloading English text cleanup" : "Downloading speech support"
    : preparation.status === "waiting" ? "Waiting for your dictation to finish"
    : cleanup ? "Preparing English text cleanup…"
    : `Preparing ${language === "Auto-detect" ? "automatic language detection" : language}…`;
  return <div className={`language-readiness ${failed ? "has-error" : ""} ${compactReady ? "is-compact" : ""}`}>
    <div className="language-readiness-heading" role="status" aria-live="polite">
      {failed || needsLanguages ? <AlertCircle size={17} /> : ready ? <Check size={17} /> : preparation.status === "downloading" ? <Download size={17} /> : <Loader2 size={17} className="animate-spin" />}
      <strong>{title}</strong>
    </div>
    {!compactReady && <p role={failed ? "alert" : undefined}>{failed ? preparation.error
      : needsLanguages ? "Select and save one to three languages in Settings → Dictation before recording."
      : ready ? "Your speech is transcribed on this Mac. No internet connection needed."
      : cleanup ? "One-time download · about 496 MB."
      : preparation.status === "downloading" ? `One-time download${preparation.model ? ` · about ${preparation.model.size_mb} MB` : ""}.`
      : "Getting speech support ready…"}</p>}
    {preparation.status === "downloading" && <div className="language-download-progress">
      <progress aria-label={cleanup ? "Text cleanup download" : "Speech support download"} max={100} value={preparation.progress} /><span>{preparation.progress}%</span>
    </div>}
    {preparation.language && preparation.language !== transcriptionLanguage && <p className="language-pending-note">
      {languageLabel(transcriptionLanguage)} remains active until {language} is ready.
    </p>}
    {failed && preparation.status !== "unavailable" && <button className="text-link" onClick={() => { void prepareLanguage(preparation.language ?? transcriptionLanguage, { applyCleanupDefault: preparation.applyCleanupDefault }).catch(() => {}); }}><RefreshCw size={13} />Retry preparation</button>}
  </div>;
}
