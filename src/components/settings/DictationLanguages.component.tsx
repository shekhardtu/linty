import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic } from "lucide-react";
import { useSettings } from "@/hooks/useSettings.hook";
import { useAppStore } from "@/store/app.store";
import { AUTO_LANGUAGE, languageLabel, modelSupportsLanguage, validAutoDetectLanguages } from "@/lib/languages.util";
import { LanguagePicker } from "@/components/shared/LanguagePicker.component";
import { FrequentLanguages } from "@/components/shared/FrequentLanguages.component";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { LanguageReadiness } from "./LanguageReadiness.component";
import { Reformatting } from "./Reformatting.component";
import { languagePreparation } from "@/services/language-preparation.service";

/** Native dictation sessions capture the saved list, never an unfinished edit. */
export function DictationLanguages() {
  const { transcriptionLanguage, autoDetectLanguages, saveTranscriptionLanguage, saveAutoDetectLanguages } = useSettings();
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);
  const dictating = useAppStore(s => s.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(s.status));
  const loadedModel = useAppStore(s => s.loadedModelFilename);
  const setCurrentView = useAppStore(s => s.setCurrentView);
  const [languages, setLanguages] = useState(autoDetectLanguages);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { setLanguages(autoDetectLanguages); }, [autoDetectLanguages]);
  const choice = preparation.language ?? transcriptionLanguage;
  const auto = choice === AUTO_LANGUAGE;
  const changed = languages.join(",") !== autoDetectLanguages.join(",");
  const ready = ["ready", "idle"].includes(preparation.status)
    && choice === transcriptionLanguage && modelSupportsLanguage(loadedModel, transcriptionLanguage)
    && (!auto || validAutoDetectLanguages(autoDetectLanguages));
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try { await saveAutoDetectLanguages(languages); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <SectionCard className="dictation-languages">
      <div className="language-choice-row">
        <div>
          <span className="field-label">Spoken language</span>
          <p>Choose one language, or Auto-detect if you switch between languages.</p>
        </div>
        <LanguagePicker value={choice} disabled={dictating || saving} onChange={language => {
          setError("");
          void saveTranscriptionLanguage(language).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            if (languagePreparation.getSnapshot().error !== message) setError(message);
          });
        }} />
      </div>
      {auto && <div className="dictation-language-options auto-detect-settings">
        <span className="field-label">Your Auto-detect languages</span>
        <p className="preferences-footnote">Choose up to three. Auto-detect tries to identify each recording’s language from this list.</p>
        <FrequentLanguages value={languages} onChange={setLanguages} disabled={dictating || saving} />
        {changed && <div className="frequent-language-actions">
          <button type="button" className="standard-button primary-button" disabled={dictating || saving || !validAutoDetectLanguages(languages)} onClick={() => { void save(); }}>
            {saving ? "Saving…" : "Save languages"}
          </button>
          <button type="button" className="standard-button" disabled={dictating || saving} onClick={() => { setLanguages(autoDetectLanguages); setError(""); }}>Cancel</button>
        </div>}
        {(changed || !autoDetectLanguages.length) && <p className="preferences-footnote">{autoDetectLanguages.length
          ? `Auto-detect currently uses: ${autoDetectLanguages.map(languageLabel).join(", ")}.`
          : "Choose and save one to three languages before using Auto-detect."}</p>}
      </div>}
      {choice === "en" && transcriptionLanguage === "en" && <div className="dictation-language-options">
        <Reformatting disabled={!ready} />
      </div>}
      {dictating && <p className="preferences-footnote" role="status">Finish dictating before changing language.</p>}
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <div className="dictation-language-status">
        <LanguageReadiness compact />
        <button type="button" className="standard-button" disabled={!ready || dictating || saving || (auto && changed)} onClick={() => setCurrentView("system-check")}>
          <Mic size={14} aria-hidden="true" />Try dictation
        </button>
      </div>
    </SectionCard>;
}
