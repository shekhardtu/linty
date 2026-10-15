import type { StateCreator } from "zustand";
import type {
  DictionaryEntry,
  DictionarySuggestion,
} from "@/types/correction.types";

/** Whether Parakeet's vocabulary (CTC keyword-spotter) models are available for this engine load. */
export type ParakeetVocabularyStatus = "idle" | "preparing" | "ready" | "error";

export interface DictionarySlice {
  dictionaryEntries: DictionaryEntry[];
  dictionarySuggestions: DictionarySuggestion[];
  suppressedDictionaryTerms: string[];
  dictionaryLoaded: boolean;
  parakeetVocabularyStatus: ParakeetVocabularyStatus;
  setParakeetVocabularyStatus: (status: ParakeetVocabularyStatus) => void;
  setDictionary: (entries: DictionaryEntry[], suggestions: DictionarySuggestion[], suppressedTerms?: string[]) => void;
}

export const createDictionarySlice: StateCreator<DictionarySlice> = (set) => ({
  dictionaryEntries: [],
  dictionarySuggestions: [],
  suppressedDictionaryTerms: [],
  dictionaryLoaded: false,
  parakeetVocabularyStatus: "idle",
  setParakeetVocabularyStatus: (parakeetVocabularyStatus) => set({ parakeetVocabularyStatus }),
  setDictionary: (dictionaryEntries, dictionarySuggestions, suppressedDictionaryTerms = []) =>
    set({ dictionaryEntries, dictionarySuggestions, suppressedDictionaryTerms, dictionaryLoaded: true }),
});
