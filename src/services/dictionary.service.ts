import { load } from "@tauri-apps/plugin-store";
import { useAppStore } from "@/store/app.store";
import { undoDictionaryChange, type DictionaryState } from "@/lib/dictionary-undo.util";
import {
  addToDictionary,
  isSuggestionReady,
  suggestionsFromCorrection,
} from "@/lib/dictionary.util";
import type {
  CorrectionRecord,
  DictionaryEntry,
  DictionaryOrigin,
  DictionarySuggestion,
} from "@/types/correction.types";

/** The personal dictionary: confirmed entries plus pending suggestions. */
const undoBatches = new Map<string, { before: DictionaryState; after: DictionaryState }>();

export async function undoCorrectionLearning(id: string) {
  const batch = undoBatches.get(id);
  if (!batch) throw new Error("Undo expired. You can remove the word in Dictionary.");
  await updateDictionary(current => undoDictionaryChange(current, batch.before, batch.after));
  undoBatches.delete(id);
}

let storePromise: ReturnType<typeof load> | undefined;
let hydration: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();

const getStore = () =>
  (storePromise ??= load("linty-dictionary.json", {
    defaults: { entries: [], suggestions: [] },
    autoSave: false,
  }).catch((error) => {
    storePromise = undefined;
    throw error;
  }));

export function initializeDictionary() {
  return (hydration ??= (async () => {
    const store = await getStore();
    const entries = (await store.get<DictionaryEntry[]>("entries")) ?? [];
    const suggestions = (await store.get<DictionarySuggestion[]>("suggestions")) ?? [];
    useAppStore.getState().setDictionary(entries, suggestions);
  })().catch((error) => {
    hydration = undefined;
    throw error;
  }));
}

/** Serialize mutations so a fast accept/dismiss cannot overwrite a concurrent learn. */
export function updateDictionary(update: (state: DictionaryState) => DictionaryState) {
  const next = writes
    .catch(() => {})
    .then(async () => {
      await initializeDictionary();
      const { dictionaryEntries, dictionarySuggestions } = useAppStore.getState();
      const result = update({ entries: dictionaryEntries, suggestions: dictionarySuggestions });
      const store = await getStore();
      try {
        await store.set("entries", result.entries);
        await store.set("suggestions", result.suggestions);
        await store.save();
      } catch (error) {
        // The plugin also saves its cache on app exit. Restore that cache after
        // failure so an unacknowledged mutation cannot be saved later on quit.
        await store.set("entries", dictionaryEntries);
        await store.set("suggestions", dictionarySuggestions);
        throw error;
      }
      useAppStore.getState().setDictionary(result.entries, result.suggestions);
    });
  writes = next;
  return next;
}

export const addDictionaryEntry = (right: string, wrong: string[], origin: DictionaryOrigin = "manual") =>
  updateDictionary(({ entries, suggestions }) => ({
    entries: addToDictionary(entries, right, wrong, origin),
    // A confirmed entry retires any suggestion it covers.
    suggestions: suggestions.filter((s) => !(s.right === right.trim() && wrong.map((w) => w.toLowerCase()).includes(s.wrong.toLowerCase()))),
  }));

export const setDictionaryEntryEnabled = (entryId: string, enabled: boolean) =>
  updateDictionary(({ entries, suggestions }) => ({
    entries: entries.map((e) => (e.entryId === entryId ? { ...e, enabled } : e)),
    suggestions,
  }));

export const removeDictionaryEntry = (entryId: string) =>
  updateDictionary(({ entries, suggestions }) => ({
    entries: entries.filter((e) => e.entryId !== entryId),
    suggestions,
  }));

export const acceptSuggestion = (suggestionId: string) =>
  updateDictionary(({ entries, suggestions }) => {
    const s = suggestions.find((x) => x.suggestionId === suggestionId);
    if (!s) return { entries, suggestions };
    return {
      entries: addToDictionary(entries, s.right, [s.wrong], "learned"),
      suggestions: suggestions.filter((x) => x.suggestionId !== suggestionId),
    };
  });

export const dismissSuggestion = (suggestionId: string) =>
  updateDictionary(({ entries, suggestions }) => ({
    entries,
    suggestions: suggestions.filter((x) => x.suggestionId !== suggestionId),
  }));

/**
 * Count how entries helped, so the most useful ones are the ones sent to the
 * engine: `recognized` = the engine got the word right thanks to the dictionary,
 * `corrected` = Linty replaced a misheard spelling after transcription.
 */
export const noteDictionaryUse = (use: { recognized: string[]; corrected: string[] }) => {
  if (!use.recognized.length && !use.corrected.length) return Promise.resolve();
  const tally = (ids: string[]) => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  };
  const recognized = tally(use.recognized);
  const corrected = tally(use.corrected);
  const now = Date.now();
  return updateDictionary(({ entries, suggestions }) => ({
    entries: entries.map((e) =>
      recognized.has(e.entryId) || corrected.has(e.entryId)
        ? {
            ...e,
            timesApplied: e.timesApplied + (corrected.get(e.entryId) ?? 0),
            timesRecognized: (e.timesRecognized ?? 0) + (recognized.get(e.entryId) ?? 0),
            lastAppliedAt: now,
          }
        : e,
    ),
    suggestions,
  }));
};

/**
 * Learn from a correction: fold its word swaps into the suggestions and, when
 * auto-learn is on, promote the ones that are ready straight into the dictionary.
 * Returns how many suggestions were added or promoted, for the toast.
 */
export const ingestCorrection = (record: CorrectionRecord, autoLearn: boolean) =>
  ingestCorrectionBatch([record], autoLearn, record.correctionId);

/** All corrections from one editing session share a save, count, and Undo. */
export async function ingestCorrectionBatch(records: CorrectionRecord[], autoLearn: boolean, batchId: string) {
  let suggested = 0, learned = 0, pending = 0;
  let batch: { before: DictionaryState; after: DictionaryState } | undefined;
  const ids = new Set(records.map(r => r.correctionId));
  await updateDictionary(({ entries, suggestions }) => {
    const before = new Set(suggestions.map(s => s.suggestionId));
    const readyBefore = new Set(suggestions.filter(isSuggestionReady).map(s => s.suggestionId));
    let nextSuggestions = suggestions;
    for (const record of records) nextSuggestions = suggestionsFromCorrection(record, nextSuggestions, entries);
    const belongs = (s: DictionarySuggestion) => s.correctionIds.some(id => ids.has(id));
    // Conflicting destinations in the same draft are not a reusable rule.
    const destinations = new Map<string, Set<string>>();
    for (const s of nextSuggestions.filter(belongs)) {
      const key = s.wrong.toLowerCase();
      if (!destinations.has(key)) destinations.set(key, new Set());
      destinations.get(key)!.add(s.right);
    }
    const conflicts = new Set([...destinations].filter(([, values]) => values.size > 1).map(([key]) => key));
    nextSuggestions = nextSuggestions.filter(s => !belongs(s) || !conflicts.has(s.wrong.toLowerCase()));
    let nextEntries = entries;
    if (autoLearn) {
      const ready = nextSuggestions.filter(s => belongs(s) && isSuggestionReady(s));
      for (const s of ready) nextEntries = addToDictionary(nextEntries, s.right, [s.wrong], "learned");
      learned = ready.length;
      nextSuggestions = nextSuggestions.filter(s => !ready.includes(s));
    }
    suggested = nextSuggestions.filter(s => belongs(s) && isSuggestionReady(s) && !readyBefore.has(s.suggestionId)).length;
    pending = nextSuggestions.filter(s => !before.has(s.suggestionId) && !isSuggestionReady(s)).length;
    const after = { entries: nextEntries, suggestions: nextSuggestions };
    batch = { before: { entries, suggestions }, after };
    return after;
  });
  if (batch && (suggested || learned || pending)) {
    undoBatches.set(batchId, batch);
    if (undoBatches.size > 20) undoBatches.delete(undoBatches.keys().next().value!);
  }
  return { suggested, learned, pending, undoId: batchId };
}
