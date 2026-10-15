import { normalizeWord } from "./correction-diff.util.ts";
import type { DictionaryState } from "./dictionary-undo.util.ts";

export const dictionaryTermKey = (word: string) => normalizeWord(word.trim()).normalize("NFC");

/** Old stores have no suppression key; malformed local data must not break
 * dictionary initialization or make every later learning save fail. */
export function normalizeSuppressedTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((term): term is string => typeof term === "string")
    .map(dictionaryTermKey).filter(Boolean))];
}

/** Deletion means stop learning this destination, regardless of which misheard
 * form a future capture contains. Retire pending suggestions at the same time. */
export function removeAndSuppressDictionaryEntry(state: DictionaryState, entryId: string): DictionaryState {
  const entry = state.entries.find(item => item.entryId === entryId);
  if (!entry) return state;
  const key = dictionaryTermKey(entry.right);
  return {
    entries: state.entries.filter(item => item.entryId !== entryId),
    suggestions: state.suggestions.filter(item => dictionaryTermKey(item.right) !== key),
    suppressedTerms: [...new Set([...(state.suppressedTerms ?? []), key])],
  };
}

/** Explicitly adding/accepting a word is the way to opt back into that term. */
export function unsuppressDictionaryTerm(terms: string[] = [], right: string): string[] {
  const key = dictionaryTermKey(right);
  return terms.filter(term => term !== key);
}
