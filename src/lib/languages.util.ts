/** Language codes: github.com/openai/whisper/blob/main/whisper/tokenizer.py.
 * Native names are bundled from ICU so browser locale coverage cannot hide them. */
export const AUTO_LANGUAGE = "auto";
export const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
export const PARAKEET_MODEL = "parakeet-tdt-0.6b-v3";
export const WHISPER_MODEL = "ggml-large-v3-turbo-q5_0.bin";

export const PARAKEET_LANGUAGES = new Set([
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
]);

export const TRANSCRIPTION_LANGUAGES: { code: string; label: string; nativeLabel: string }[] = [
  { code: AUTO_LANGUAGE, label: "Auto-detect", nativeLabel: "Recognize the language you speak" },
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "af", label: "Afrikaans", nativeLabel: "Afrikaans" },
  { code: "sq", label: "Albanian", nativeLabel: "shqip" },
  { code: "am", label: "Amharic", nativeLabel: "አማርኛ" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية" },
  { code: "hy", label: "Armenian", nativeLabel: "հայերեն" },
  { code: "as", label: "Assamese", nativeLabel: "অসমীয়া" },
  { code: "az", label: "Azerbaijani", nativeLabel: "azərbaycan" },
  { code: "ba", label: "Bashkir", nativeLabel: "башҡорт" },
  { code: "eu", label: "Basque", nativeLabel: "euskara" },
  { code: "be", label: "Belarusian", nativeLabel: "беларуская" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "bs", label: "Bosnian", nativeLabel: "bosanski" },
  { code: "br", label: "Breton", nativeLabel: "brezhoneg" },
  { code: "bg", label: "Bulgarian", nativeLabel: "български" },
  { code: "my", label: "Burmese", nativeLabel: "မြန်မာ" },
  { code: "yue", label: "Cantonese", nativeLabel: "粵語" },
  { code: "ca", label: "Catalan", nativeLabel: "català" },
  { code: "zh", label: "Chinese", nativeLabel: "中文" },
  { code: "hr", label: "Croatian", nativeLabel: "hrvatski" },
  { code: "cs", label: "Czech", nativeLabel: "čeština" },
  { code: "da", label: "Danish", nativeLabel: "dansk" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
  { code: "et", label: "Estonian", nativeLabel: "eesti" },
  { code: "fo", label: "Faroese", nativeLabel: "føroyskt" },
  { code: "fi", label: "Finnish", nativeLabel: "suomi" },
  { code: "fr", label: "French", nativeLabel: "français" },
  { code: "gl", label: "Galician", nativeLabel: "galego" },
  { code: "ka", label: "Georgian", nativeLabel: "ქართული" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "el", label: "Greek", nativeLabel: "Ελληνικά" },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી" },
  { code: "ht", label: "Haitian Creole", nativeLabel: "Kreyòl ayisyen" },
  { code: "ha", label: "Hausa", nativeLabel: "Hausa" },
  { code: "haw", label: "Hawaiian", nativeLabel: "ʻŌlelo Hawaiʻi" },
  { code: "he", label: "Hebrew", nativeLabel: "עברית" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "hu", label: "Hungarian", nativeLabel: "magyar" },
  { code: "is", label: "Icelandic", nativeLabel: "íslenska" },
  { code: "id", label: "Indonesian", nativeLabel: "Indonesia" },
  { code: "it", label: "Italian", nativeLabel: "italiano" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "jw", label: "Javanese", nativeLabel: "Jawa" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ" },
  { code: "kk", label: "Kazakh", nativeLabel: "қазақ тілі" },
  { code: "km", label: "Khmer", nativeLabel: "ខ្មែរ" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "lo", label: "Lao", nativeLabel: "ລາວ" },
  { code: "la", label: "Latin", nativeLabel: "Latina" },
  { code: "lv", label: "Latvian", nativeLabel: "latviešu" },
  { code: "ln", label: "Lingala", nativeLabel: "lingála" },
  { code: "lt", label: "Lithuanian", nativeLabel: "lietuvių" },
  { code: "lb", label: "Luxembourgish", nativeLabel: "Lëtzebuergesch" },
  { code: "mk", label: "Macedonian", nativeLabel: "македонски" },
  { code: "mg", label: "Malagasy", nativeLabel: "Malagasy" },
  { code: "ms", label: "Malay", nativeLabel: "Melayu" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം" },
  { code: "mt", label: "Maltese", nativeLabel: "Malti" },
  { code: "mi", label: "Maori", nativeLabel: "Māori" },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी" },
  { code: "mn", label: "Mongolian", nativeLabel: "монгол" },
  { code: "ne", label: "Nepali", nativeLabel: "नेपाली" },
  { code: "no", label: "Norwegian", nativeLabel: "norsk" },
  { code: "nn", label: "Nynorsk", nativeLabel: "norsk nynorsk" },
  { code: "oc", label: "Occitan", nativeLabel: "occitan" },
  { code: "ps", label: "Pashto", nativeLabel: "پښتو" },
  { code: "fa", label: "Persian", nativeLabel: "فارسی" },
  { code: "pl", label: "Polish", nativeLabel: "polski" },
  { code: "pt", label: "Portuguese", nativeLabel: "português" },
  { code: "pa", label: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ" },
  { code: "ro", label: "Romanian", nativeLabel: "română" },
  { code: "ru", label: "Russian", nativeLabel: "русский" },
  { code: "sa", label: "Sanskrit", nativeLabel: "संस्कृत भाषा" },
  { code: "sr", label: "Serbian", nativeLabel: "српски" },
  { code: "sn", label: "Shona", nativeLabel: "chiShona" },
  { code: "sd", label: "Sindhi", nativeLabel: "سنڌي" },
  { code: "si", label: "Sinhala", nativeLabel: "සිංහල" },
  { code: "sk", label: "Slovak", nativeLabel: "slovenčina" },
  { code: "sl", label: "Slovenian", nativeLabel: "slovenščina" },
  { code: "so", label: "Somali", nativeLabel: "Soomaali" },
  { code: "es", label: "Spanish", nativeLabel: "español" },
  { code: "su", label: "Sundanese", nativeLabel: "Basa Sunda" },
  { code: "sw", label: "Swahili", nativeLabel: "Kiswahili" },
  { code: "sv", label: "Swedish", nativeLabel: "svenska" },
  { code: "tl", label: "Tagalog", nativeLabel: "Filipino" },
  { code: "tg", label: "Tajik", nativeLabel: "тоҷикӣ" },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்" },
  { code: "tt", label: "Tatar", nativeLabel: "татар" },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు" },
  { code: "th", label: "Thai", nativeLabel: "ไทย" },
  { code: "bo", label: "Tibetan", nativeLabel: "བོད་སྐད་" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
  { code: "tk", label: "Turkmen", nativeLabel: "türkmen dili" },
  { code: "uk", label: "Ukrainian", nativeLabel: "українська" },
  { code: "ur", label: "Urdu", nativeLabel: "اردو" },
  { code: "uz", label: "Uzbek", nativeLabel: "o‘zbek" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "cy", label: "Welsh", nativeLabel: "Cymraeg" },
  { code: "yi", label: "Yiddish", nativeLabel: "ייִדיש" },
  { code: "yo", label: "Yoruba", nativeLabel: "Èdè Yorùbá" },
];

export function isSupportedLanguage(code: string | null | undefined): boolean {
  return TRANSCRIPTION_LANGUAGES.some((language) => language.code === code);
}

export function languageLabel(code: string): string {
  return TRANSCRIPTION_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** Bundled endonyms stay searchable even in WebViews with limited ICU locales. */
export function nativeLanguageLabel(code: string): string {
  return TRANSCRIPTION_LANGUAGES.find((language) => language.code === code)?.nativeLabel ?? languageLabel(code);
}

export function modelSupportsLanguage(filename: string | null, language: string): boolean {
  return isSupportedLanguage(language) && (filename === WHISPER_MODEL || filename === PARAKEET_MODEL && PARAKEET_LANGUAGES.has(language));
}

/** The native catalog already accounts for hardware and build capabilities. */
export function modelForLanguage<T extends { filename: string }>(language: string, catalog: readonly T[]): T | undefined {
  if (!isSupportedLanguage(language)) return undefined;
  if (PARAKEET_LANGUAGES.has(language)) {
    const parakeet = catalog.find((model) => model.filename === PARAKEET_MODEL);
    if (parakeet) return parakeet;
  }
  return catalog.find((model) => model.filename === WHISPER_MODEL);
}
