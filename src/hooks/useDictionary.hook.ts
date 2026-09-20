import { useEffect } from "react";
import { useAppStore } from "@/store/app.store";
import {
  acceptSuggestion,
  addDictionaryEntry,
  dismissSuggestion,
  initializeDictionary,
  removeDictionaryEntry,
  setDictionaryEntryEnabled,
} from "@/services/dictionary.service";
import { initializeCorrections } from "@/services/user-corrections.service";
import { isSuggestionReady } from "@/lib/dictionary.util";

/** Dictionary entries, pending suggestions and the person's corrections, hydrated on first use. */
export function useDictionary() {
  const entries = useAppStore((s) => s.dictionaryEntries);
  const suggestions = useAppStore((s) => s.dictionarySuggestions);
  const loaded = useAppStore((s) => s.dictionaryLoaded);

  useEffect(() => {
    initializeDictionary().catch((error) => console.error("Failed to load dictionary:", error));
    initializeCorrections().catch((error) => console.error("Failed to load corrections:", error));
  }, []);

  return {
    entries,
    /** Suggestions with native spelling evidence, repeated sightings, or a proper noun. */
    readySuggestions: suggestions.filter(isSuggestionReady),
    /** Everything seen once that is still waiting for a second sighting. */
    pendingSuggestions: suggestions.filter((s) => !isSuggestionReady(s)),
    loaded,
    addEntry: addDictionaryEntry,
    setEntryEnabled: setDictionaryEntryEnabled,
    removeEntry: removeDictionaryEntry,
    acceptSuggestion,
    dismissSuggestion,
  };
}
