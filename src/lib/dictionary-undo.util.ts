import type { DictionaryEntry, DictionarySuggestion } from "../types/correction.types";
import { dictionaryTermKey } from "./dictionary-suppression.util.ts";

export interface DictionaryState {
  entries: DictionaryEntry[];
  suggestions: DictionarySuggestion[];
  /** Normalized destinations deliberately removed from automatic learning. */
  suppressedTerms?: string[];
}

/** Restore only objects changed by this batch. A later edit to the same object
 * makes undo fail explicitly; unrelated words and sightings are preserved. */
export function undoDictionaryChange(current: DictionaryState, before: DictionaryState, after: DictionaryState): DictionaryState {
  function restore<T>(current: T[], before: T[], after: T[], key: (item: T) => string): T[] {
    const ids = new Set([...before, ...after].map(key));
    let result = current;
    for (const id of ids) {
      const old = before.find(item => key(item) === id);
      const saved = after.find(item => key(item) === id);
      if (JSON.stringify(old) === JSON.stringify(saved)) continue;
      const present = current.find(item => key(item) === id);
      if (JSON.stringify(present) !== JSON.stringify(saved)) {
        throw new Error("This word has changed since learning. Review it in Dictionary.");
      }
      result = result.filter(item => key(item) !== id);
      if (old) result = [...result, old];
    }
    return result;
  }
  const entries = restore(current.entries, before.entries, after.entries, entry => entry.entryId);
  const suggestions = restore(current.suggestions, before.suggestions, after.suggestions, suggestion => suggestion.suggestionId);
  // Undoing a newly learned word is also a deliberate rejection. Preserve
  // suppression added by later deletions, rather than restoring an old list.
  const removedTerms = after.entries.filter(entry => !before.entries.some(old => old.entryId === entry.entryId)
    && !entries.some(present => present.entryId === entry.entryId))
    .map(entry => dictionaryTermKey(entry.right));
  return {
    ...current,
    entries,
    suggestions,
    suppressedTerms: [...new Set([...(current.suppressedTerms ?? []), ...removedTerms])],
  };
}
