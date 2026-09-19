import { useAppStore } from "@/store/app.store";
import { engineTerms, promptWithDictionary } from "@/lib/dictionary.util";
import { modelLabel } from "@/lib/model-labels.util";
import { reformatOptions } from "@/lib/reformat.util";

/** Capture configuration once. Native processing never reads changing UI state. */
export function dictationOptions() {
  const s = useAppStore.getState();
  const filename = s.loadedModelFilename ?? s.selectedModelFilename;
  const dictionary = s.dictionaryEnabled ? s.dictionaryEntries.filter(e => e.enabled) : [];
  return {
    local: s.sttMode === "local", filename,
    modelName: s.sttMode === "cloud" ? "Groq Whisper Large V3 Turbo" : modelLabel(filename),
    language: s.transcriptionLanguage,
    prompt: s.dictionaryEnabled ? promptWithDictionary(s.whisperPrompt, dictionary) : s.whisperPrompt,
    vocabulary: engineTerms(dictionary).map(e => ({ text: e.right, aliases: e.wrong })),
    dictionary, cleanup: s.reformatEnabled,
    cleanupOptions: reformatOptions(s.reformatStyle, s.reformatLists, s.reformatContext),
    cleanupContextAuto: s.reformatContext === "auto",
    cloudCorrection: s.correctionEnabled, correctionPrompt: s.correctionPrompt,
    observeCorrections: s.observeCorrections, trackApplication: s.trackApplicationUsage,
  };
}
