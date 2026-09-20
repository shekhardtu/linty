import { X } from "lucide-react";
import { LanguagePicker } from "./LanguagePicker.component";
import { AUTO_LANGUAGE, MAX_AUTO_DETECT_LANGUAGES, languageLabel } from "@/lib/languages.util";

export function FrequentLanguages({ value, onChange, disabled = false }: {
  value: string[];
  onChange: (languages: string[]) => void;
  disabled?: boolean;
}) {
  return <div className="frequent-languages" role="group" aria-label="Frequently spoken languages">
    <div className="frequent-language-choices">
      {value.map(code => <button key={code} type="button" className="standard-button"
        aria-label={`Remove ${languageLabel(code)}`} disabled={disabled}
        onClick={() => onChange(value.filter(language => language !== code))}>
        {languageLabel(code)}<X size={13} aria-hidden="true" />
      </button>)}
      <LanguagePicker value="" label="Add spoken language" placeholder="Add a language"
        exclude={[AUTO_LANGUAGE, ...value]} disabled={disabled || value.length >= MAX_AUTO_DETECT_LANGUAGES}
        onChange={code => {
          if (value.length < MAX_AUTO_DETECT_LANGUAGES && !value.includes(code)) onChange([...value, code]);
        }} />
    </div>
    <p className="preferences-footnote" role="status">
      {value.length} of {MAX_AUTO_DETECT_LANGUAGES} selected. {value.length >= MAX_AUTO_DETECT_LANGUAGES
        ? "Remove a language to choose another." : value.length === 0 ? "Choose at least one language." : "You can add more languages."}
    </p>
  </div>;
}
