import type {
  CorrectionPair,
  CorrectionRecord,
  DictionaryEntry,
  DictionarySuggestion,
} from "../types/correction.types";
import { isSpellingCorrection } from "./correction-classifier.ts";
import { isWordBoundaryCorrection, normalizeWord } from "./correction-diff.util.ts";

/** Roughly 224 Whisper tokens; keeps the prompt within what the engines accept. */
export const PROMPT_CHAR_BUDGET = 600;
/** Parakeet's vocabulary boost is best under 50 terms; the rest stay as replacements. */
export const ENGINE_TERM_BUDGET = 50;
/** A pair seen this often becomes a suggestion even for ordinary-looking words. */
export const SUGGEST_AFTER_SIGHTINGS = 2;

/** Everyday words that must never be auto-learned as replacements. */
const COMMON_WORDS = new Set(
  `the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had did does am here where why very much more many such through own same too again once off down before under between while during too there their they're you're its it's a an the`
    .split(/\s+/)
    .filter(Boolean),
);

export function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(normalizeWord(word));
}

/** Capitalised word, or an acronym: worth learning after a single sighting. */
export function isProperNoun(word: string): boolean {
  const core = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return /^\p{Lu}/u.test(core) && core.length >= 2;
}

/** Strip surrounding punctuation but keep the word's own casing. */
function bareWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * The substitutions in a correction that could become dictionary entries:
 * single-word swaps (including names split or joined by the engine) where the
 * new word is not an everyday word.
 */
export function learnablePairs(pairs: CorrectionPair[]): { from: string; to: string }[] {
  const seen = new Set<string>();
  const out: { from: string; to: string }[] = [];
  for (const pair of pairs) {
    if (pair.kind !== "substitution") continue;
    const from = bareWord(pair.from);
    const to = bareWord(pair.to);
    if (!from || !to) continue;
    if ((/\s/u.test(from) || /\s/u.test(to)) && !isWordBoundaryCorrection(from, to)) continue;
    if (from.length < 2 || to.length < 2) continue;
    if (from === to) continue;
    if (isCommonWord(to)) continue;
    const key = `${normalizeWord(from)}→${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
  }
  return out;
}

/** True when an enabled entry already maps this wrong form to this right form. */
export function isKnownToDictionary(entries: DictionaryEntry[], from: string, to: string): boolean {
  const wrong = normalizeWord(from);
  return entries.some(
    (e) => e.right === to && (normalizeWord(from) === normalizeWord(to)
      || e.wrong.some((w) => normalizeWord(w) === wrong)),
  );
}

/** Fold a correction into the suggestion list; returns the new list (immutable). */
export function suggestionsFromCorrection(
  record: CorrectionRecord,
  suggestions: DictionarySuggestion[],
  entries: DictionaryEntry[],
): DictionarySuggestion[] {
  if (record.rewrite) return suggestions;
  let next = suggestions;
  for (const { from, to } of learnablePairs(record.pairs)) {
    if (record.source === "observed" && (!isSpellingCorrection(from, to) || isCommonWord(from))) continue;
    if (isKnownToDictionary(entries, from, to)) continue;
    if (record.source === "observed" && entries.some(e => e.right !== to
      && e.wrong.some(w => normalizeWord(w) === normalizeWord(from)))) continue;
    const wrong = normalizeWord(from);
    const existing = next.find((s) => s.right === to && normalizeWord(s.wrong) === wrong);
    if (existing) {
      if (existing.correctionIds.includes(record.correctionId)) continue;
      next = next.map((s) =>
        s === existing
          ? {
              ...s,
              seenCount: s.seenCount + 1,
              spellingEvidence: s.spellingEvidence || record.source === "observed",
              lastSeenAt: record.timestamp,
              correctionIds: [...s.correctionIds, record.correctionId],
            }
          : s,
      );
    } else {
      next = [
        ...next,
        {
          suggestionId: `s-${record.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          right: to,
          wrong: from,
          seenCount: 1,
          spellingEvidence: record.source === "observed",
          firstSeenAt: record.timestamp,
          lastSeenAt: record.timestamp,
          correctionIds: [record.correctionId],
        },
      ];
    }
  }
  return next;
}

/** Native spelling evidence is ready once. Explicit History edits retain the
 * existing proper-noun / repeated-sighting policy. */
export function isSuggestionReady(s: DictionarySuggestion): boolean {
  return s.spellingEvidence === true || s.seenCount >= SUGGEST_AFTER_SIGHTINGS || isProperNoun(s.right);
}

/** Merge a wrong → right pair into the entries; extends an existing entry for the same right form. */
export function addToDictionary(
  entries: DictionaryEntry[],
  right: string,
  wrong: string[],
  origin: DictionaryEntry["origin"],
  now = Date.now(),
): DictionaryEntry[] {
  const cleanRight = bareWord(right.trim());
  const cleanWrong = wrong.map((w) => bareWord(w.trim())).filter((w) => w && normalizeWord(w) !== normalizeWord(cleanRight));
  if (!cleanRight) return entries;
  const existing = entries.find((e) => e.right === cleanRight);
  if (existing) {
    const known = new Set(existing.wrong.map(normalizeWord));
    const merged = [...existing.wrong, ...cleanWrong.filter((w) => !known.has(normalizeWord(w)))];
    return entries.map((e) => (e === existing ? { ...e, wrong: merged, enabled: true } : e));
  }
  return [
    ...entries,
    {
      entryId: `d-${now}-${Math.random().toString(36).slice(2, 8)}`,
      right: cleanRight,
      wrong: cleanWrong,
      enabled: true,
      origin,
      timesApplied: 0,
      timesRecognized: 0,
      createdAt: now,
    },
  ];
}

/** Match the casing style of the token being replaced. */
function matchCase(replacement: string, matched: string): string {
  if (matched.length > 1 && matched === matched.toUpperCase() && /\p{L}/u.test(matched)) {
    return replacement.toUpperCase();
  }
  if (/^\p{Lu}/u.test(matched) && /^\p{Ll}/u.test(replacement)) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DictionaryApplication {
  entryId: string;
  from: string;
  to: string;
}

/** Whole-word, case-insensitive replacement of every enabled entry's wrong forms. */
export function applyDictionary(
  text: string,
  entries: DictionaryEntry[],
): { text: string; applied: DictionaryApplication[] } {
  let out = text;
  const applied: DictionaryApplication[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    for (const wrong of entry.wrong) {
      if (!wrong) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(wrong)}(?![\\p{L}\\p{N}])`, "giu");
      out = out.replace(pattern, (matched) => {
        const to = matchCase(entry.right, matched);
        applied.push({ entryId: entry.entryId, from: matched, to });
        return to;
      });
    }
  }
  return { text: out, applied };
}

/** Every time an entry helped: recognised by the engine or corrected by Linty afterwards. */
export function timesHelped(entry: DictionaryEntry): number {
  return entry.timesApplied + (entry.timesRecognized ?? 0);
}

/** Right forms most worth telling the engine about, most-helpful first. */
export function engineTerms(entries: DictionaryEntry[], limit = ENGINE_TERM_BUDGET): DictionaryEntry[] {
  return entries
    .filter((e) => e.enabled)
    .sort((a, b) => timesHelped(b) - timesHelped(a) || b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** The manual vocabulary prompt followed by dictionary terms, within the token budget. */
export function promptWithDictionary(
  manualPrompt: string,
  entries: DictionaryEntry[],
  budget = PROMPT_CHAR_BUDGET,
): string {
  const parts: string[] = [];
  let length = 0;
  const manual = manualPrompt.trim();
  if (manual) {
    parts.push(manual);
    length = manual.length;
  }
  const seen = new Set(manual.toLowerCase().split(/[\s,]+/));
  for (const entry of engineTerms(entries, Number.POSITIVE_INFINITY)) {
    if (seen.has(entry.right.toLowerCase())) continue;
    if (length + entry.right.length + 2 > budget) break;
    parts.push(entry.right);
    seen.add(entry.right.toLowerCase());
    length += entry.right.length + 2;
  }
  return parts.join(", ");
}

/** Corrections per 100 pasted words; rewrites count as one correction each. */
export function correctionsPer100Words(records: CorrectionRecord[], totalWords: number): number | null {
  if (!totalWords) return null;
  const corrections = records.reduce((sum, r) => sum + (r.rewrite ? 1 : r.pairs.length), 0);
  return Math.round((corrections / totalWords) * 1000) / 10;
}
