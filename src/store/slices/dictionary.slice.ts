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
  dictionaryLoaded: boolean;
  parakeetVocabularyStatus: ParakeetVocabularyStatus;
  setParakeetVocabularyStatus: (status: ParakeetVocabularyStatus) => void;
  setDictionary: (entries: DictionaryEntry[], suggestions: DictionarySuggestion[]) => void;
}

export const createDictionarySlice: StateCreator<DictionarySlice> = (set) => ({
  dictionaryEntries: [],
  dictionarySuggestions: [],
  dictionaryLoaded: false,
  parakeetVocabularyStatus: "idle",
  setParakeetVocabularyStatus: (parakeetVocabularyStatus) => set({ parakeetVocabularyStatus }),
  setDictionary: (dictionaryEntries, dictionarySuggestions) =>
    set({ dictionaryEntries, dictionarySuggestions, dictionaryLoaded: true }),
});
