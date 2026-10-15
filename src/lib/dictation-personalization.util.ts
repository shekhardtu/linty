import type { AppStyleProfile, VoiceSnippet } from "../types/dictation-personalization.types.ts";
import type { ReformatStyle } from "../types/reformat.types.ts";

export const WRITING_STYLES: { value: ReformatStyle; label: string }[] = [
  { value: "casual", label: "Casual" }, { value: "semi-casual", label: "Semi-casual" },
  { value: "semi-formal", label: "Standard" }, { value: "formal", label: "Formal" },
];
export function snippetPhrase(phrase: string) {
  return phrase.trim().replace(/[.!?。！？]+$/u, "").trim().toLowerCase();
}
export function normalizeSnippets(value: unknown): VoiceSnippet[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  return value.filter((entry): entry is VoiceSnippet => {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.phrase !== "string" || typeof entry.text !== "string") return false;
    const phrase = snippetPhrase(entry.phrase);
    if (!phrase || phrase.length > 120 || !entry.text.trim() || entry.text.length > 10000 || entry.text.includes("\0") || seen.has(phrase) || ids.has(entry.id)) return false;
    seen.add(phrase);
    ids.add(entry.id);
    return true;
  }).slice(0, 100).map(({ id, phrase, text }) => ({ id, phrase: phrase.trim(), text }));
}
export function normalizeAppStyles(value: unknown): AppStyleProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is AppStyleProfile => {
    if (!entry || typeof entry.bundleId !== "string" || entry.bundleId.length > 255 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(entry.bundleId) || seen.has(entry.bundleId) || !WRITING_STYLES.some((s) => s.value === entry.style)) return false;
    seen.add(entry.bundleId);
    return true;
  }).slice(0, 100).map(({ bundleId, style }) => ({ bundleId, style }));
}
