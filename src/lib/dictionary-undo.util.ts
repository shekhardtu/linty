import type { DictionaryEntry, DictionarySuggestion } from "../types/correction.types";

export interface DictionaryState {
  entries: DictionaryEntry[];
  suggestions: DictionarySuggestion[];
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
  return {
    entries: restore(current.entries, before.entries, after.entries, entry => entry.entryId),
    suggestions: restore(current.suggestions, before.suggestions, after.suggestions, suggestion => suggestion.suggestionId),
  };
}
