import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSettings } from "@/hooks/useSettings.hook";
import { useAppStore } from "@/store/app.store";
import { AUTO_LANGUAGE, languageLabel, validAutoDetectLanguages } from "@/lib/languages.util";
import { LanguagePicker } from "@/components/shared/LanguagePicker.component";
import { FrequentLanguages } from "@/components/shared/FrequentLanguages.component";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { LanguageReadiness } from "./LanguageReadiness.component";
import { languagePreparation } from "@/services/language-preparation.service";

/** Shared by Dictation and Language settings; native sessions capture the saved list. */
export function DictationLanguages() {
  const { transcriptionLanguage, autoDetectLanguages, saveTranscriptionLanguage, saveAutoDetectLanguages } = useSettings();
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);
  const dictating = useAppStore(s => s.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(s.status));
  const [languages, setLanguages] = useState(autoDetectLanguages);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { setLanguages(autoDetectLanguages); }, [autoDetectLanguages]);
  const choice = preparation.language ?? transcriptionLanguage;
  const auto = choice === AUTO_LANGUAGE;
  const changed = languages.join(",") !== autoDetectLanguages.join(",");
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try { await saveAutoDetectLanguages(languages); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <>
    <SectionCard>
      <div className="language-choice-row">
        <div>
          <span className="field-label">Dictation language</span>
          <p>Select a specific language, or use Auto-detect with your frequently spoken languages.</p>
        </div>
        <LanguagePicker value={choice} disabled={dictating || saving} onChange={language => {
          setError("");
          void saveTranscriptionLanguage(language).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            if (languagePreparation.getSnapshot().error !== message) setError(message);
          });
        }} />
      </div>
      {auto && <div className="auto-detect-settings">
        <span className="field-label">Frequently spoken languages</span>
        <p className="preferences-footnote">Choose up to three. Auto-detect will try to identify the language of each recording using only your saved languages.</p>
        <FrequentLanguages value={languages} onChange={setLanguages} disabled={dictating || saving} />
        <div className="frequent-language-actions">
          <button type="button" className="standard-button primary-button" disabled={dictating || saving || !changed || !validAutoDetectLanguages(languages)} onClick={() => { void save(); }}>
            {saving ? "Saving…" : "Save languages"}
          </button>
          {changed && <button type="button" className="standard-button" disabled={dictating || saving} onClick={() => { setLanguages(autoDetectLanguages); setError(""); }}>Cancel</button>}
        </div>
        <p className="preferences-footnote">{autoDetectLanguages.length
          ? `Auto-detect currently uses: ${autoDetectLanguages.map(languageLabel).join(", ")}.`
          : "Choose and save one to three languages before using Auto-detect."}</p>
      </div>}
      <p className="preferences-footnote">{dictating ? "Finish dictating before changing language." : "App menus stay in English. This preference controls speech recognition, not translation."}</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
    </SectionCard>
    <LanguageReadiness />
  </>;
}
