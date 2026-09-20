import test from "node:test";
import assert from "node:assert/strict";
import { diffCorrection, wordDiff, REWRITE_THRESHOLD } from "../src/lib/correction-diff.util.ts";
import { correctionFeedback } from "../src/lib/correction-feedback.ts";
import {
  addToDictionary,
  applyDictionary,
  correctionsPer100Words,
  isSuggestionReady,
  learnablePairs,
  promptWithDictionary,
  engineTerms,
  suggestionsFromCorrection,
} from "../src/lib/dictionary.util.ts";

const now = 1_757_900_000_000;

test("feedback promises future use only for saved, enabled dictionary learning", () => {
  assert.equal(correctionFeedback({ learned: 1, suggested: 0 }, true).message, "I’ll remember it next time.");
  assert.equal(correctionFeedback({ learned: 1, suggested: 0 }, false).message, "Saved. Turn on Dictionary to use it.");
  assert.equal(correctionFeedback({ learned: 0, suggested: 1 }, true).learned, false);
  assert.equal(correctionFeedback({ learned: 0, suggested: 0, pending: 1 }, true).message, "I’ll keep learning from your edits.");
  assert.equal(correctionFeedback({ learned: 0, suggested: 0 }, true), null);
});

test("word diff pairs equal-length runs one to one and keeps punctuation with the word", () => {
  const pairs = wordDiff(
    "names like Tari, Zustan and Figna are spelled",
    "names like Tauri, Zustand and Figma are spelled",
  );
  assert.deepEqual(pairs, [
    { kind: "substitution", from: "Tari,", to: "Tauri," },
    { kind: "substitution", from: "Zustan", to: "Zustand" },
    { kind: "substitution", from: "Figna", to: "Figma" },
  ]);
  assert.deepEqual(wordDiff("a b c", "a b c d"), [{ kind: "insertion", from: "", to: "d" }]);
  assert.deepEqual(wordDiff("a b c", "a c"), [{ kind: "deletion", from: "b", to: "" }]);
  assert.deepEqual(wordDiff("same", "same"), []);
});

test("a heavy rewrite is flagged and yields no learnable pairs", () => {
  const fix = diffCorrection("send the invoice to the client by friday", "send the invoice to the client by Friday");
  assert.equal(fix.rewrite, false);
  assert.equal(fix.wordCount, 8);
  const rewrite = diffCorrection("send the invoice to the client", "please forward that bill tomorrow");
  assert.equal(rewrite.rewrite, true);
  assert.ok(rewrite.changedRatio > REWRITE_THRESHOLD);
  const record = { correctionId: "c1", transcriptId: "t1", timestamp: now, source: "edit", engine: "local", modelName: "Parakeet TDT v3", language: "en", wordCount: rewrite.wordCount, changedRatio: rewrite.changedRatio, rewrite: true, pairs: rewrite.pairs };
  assert.deepEqual(suggestionsFromCorrection(record, [], []), []);
});

test("learnable pairs skip everyday words and multi-word swaps", () => {
  const pairs = learnablePairs([
    { kind: "substitution", from: "Tari,", to: "Tauri," },
    { kind: "substitution", from: "there", to: "their" },
    { kind: "substitution", from: "few seconds per", to: "Parakeet" },
    { kind: "substitution", from: "linty", to: "Linty" },
    { kind: "insertion", from: "", to: "Figma" },
  ]);
  assert.deepEqual(pairs, [
    { from: "Tari", to: "Tauri" },
    { from: "linty", to: "Linty" },
  ]);
});

test("joining or splitting a name is a learnable correction, including in a short sentence", () => {
  for (const [before, after, from, to] of [
    ['My name is Hari Shekhar.', 'My name is Harishekhar.', 'Hari Shekhar', 'Harishekhar'],
    ['My name is Harishekhar.', 'My name is Hari Shekhar.', 'Harishekhar', 'Hari Shekhar'],
  ]) {
    const diff = diffCorrection(before, after);
    assert.equal(diff.rewrite, false);
    assert.deepEqual(learnablePairs(diff.pairs), [{ from, to }]);
    const entries = addToDictionary([], to, [from], 'learned', now);
    assert.equal(applyDictionary(before, entries).text, after);
    assert.equal(applyDictionary(`Meet ${from}son.`, entries).applied.length, 0, 'The name must still match whole words');
  }
  assert.deepEqual(learnablePairs([{ kind: 'substitution', from: 'few seconds per', to: 'Parakeet' }]), []);
});

test("suggestions count sightings and proper nouns are ready at once", () => {
  const base = { transcriptId: "t", source: "edit", engine: "local", modelName: "m", language: "en", wordCount: 10, changedRatio: 0.1, rewrite: false };
  const first = { ...base, correctionId: "c1", timestamp: now, pairs: [{ kind: "substitution", from: "Figna", to: "Figma" }, { kind: "substitution", from: "recieve", to: "receive" }] };
  const second = { ...base, correctionId: "c2", timestamp: now + 1, pairs: [{ kind: "substitution", from: "recieve", to: "receive" }] };
  let suggestions = suggestionsFromCorrection(first, [], []);
  assert.equal(suggestions.length, 2);
  const figma = suggestions.find((s) => s.right === "Figma");
  const receive = suggestions.find((s) => s.right === "receive");
  assert.equal(isSuggestionReady(figma), true, "proper noun after one sighting");
  assert.equal(isSuggestionReady(receive), false, "ordinary word needs two sightings");
  suggestions = suggestionsFromCorrection(second, suggestions, []);
  assert.equal(suggestions.find((s) => s.right === "receive").seenCount, 2);
  assert.equal(isSuggestionReady(suggestions.find((s) => s.right === "receive")), true);
  // Already in the dictionary: no suggestion.
  const entries = addToDictionary([], "Figma", ["Figna"], "manual", now);
  assert.deepEqual(suggestionsFromCorrection(first, [], entries).map((s) => s.right), ["receive"]);
  // Same correction folded twice does not double count.
  assert.equal(suggestionsFromCorrection(second, suggestions, []).find((s) => s.right === "receive").seenCount, 2);
});

test("dictionary replaces whole words, keeps punctuation and matches casing", () => {
  let entries = addToDictionary([], "Tauri", ["Tari", "Tory"], "learned", now);
  entries = addToDictionary(entries, "Zustand", ["Zustan"], "manual", now);
  entries = addToDictionary(entries, "Tauri", ["tarry"], "manual", now); // merges into the existing entry
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].wrong, ["Tari", "Tory", "tarry"]);
  const { text, applied } = applyDictionary("Tari, then TARI and tarrying with Zustan.", entries);
  assert.equal(text, "Tauri, then TAURI and tarrying with Zustand.");
  assert.deepEqual(applied.map((a) => `${a.from}>${a.to}`), ["Tari>Tauri", "TARI>TAURI", "Zustan>Zustand"]);
  const disabled = entries.map((e) => ({ ...e, enabled: false }));
  assert.equal(applyDictionary("Tari", disabled).text, "Tari");
});

test("engine terms rank by every time an entry helped, recognised or corrected", () => {
  let entries = addToDictionary([], "Tauri", ["Tari"], "manual", now);
  entries = addToDictionary(entries, "Zustand", ["Zustan"], "manual", now);
  entries = addToDictionary(entries, "Figma", ["Figna"], "manual", now);
  entries[0] = { ...entries[0], timesApplied: 2, timesRecognized: 4 }; // Tauri: 6
  entries[1] = { ...entries[1], timesApplied: 5 }; // Zustand: 5
  entries[2] = { ...entries[2], timesRecognized: 7 }; // Figma: 7
  assert.deepEqual(engineTerms(entries).map((e) => e.right), ["Figma", "Tauri", "Zustand"]);
  assert.deepEqual(engineTerms(entries, 1).map((e) => e.right), ["Figma"]);
});

test("engine prompt appends dictionary terms after the manual prompt within the budget", () => {
  let entries = addToDictionary([], "Tauri", ["Tari"], "manual", now);
  entries = addToDictionary(entries, "Zustand", ["Zustan"], "manual", now);
  entries[1] = { ...entries[1], timesApplied: 5 };
  assert.equal(promptWithDictionary("Linty, Figma", entries), "Linty, Figma, Zustand, Tauri");
  assert.equal(promptWithDictionary("", entries, 12), "Zustand");
  assert.equal(promptWithDictionary("tauri", entries), "tauri, Zustand");
});

test("corrections per 100 words counts pairs and treats a rewrite as one", () => {
  const records = [
    { correctionId: "a", transcriptId: "t", timestamp: now, source: "edit", engine: "local", modelName: "m", language: "en", wordCount: 50, changedRatio: 0.04, rewrite: false, pairs: [{ kind: "substitution", from: "a", to: "b" }, { kind: "deletion", from: "um", to: "" }] },
    { correctionId: "b", transcriptId: "t2", timestamp: now, source: "edit", engine: "local", modelName: "m", language: "en", wordCount: 50, changedRatio: 0.9, rewrite: true, pairs: [{ kind: "substitution", from: "x y z", to: "p q" }] },
  ];
  assert.equal(correctionsPer100Words(records, 300), 1);
  assert.equal(correctionsPer100Words(records, 0), null);
});


test("undo restores only the correction batch and refuses to overwrite newer edits", async () => {
  const { undoDictionaryChange } = await import("../src/lib/dictionary-undo.util.ts");
  const before = { entries: addToDictionary([], "Figma", ["Figna"], "manual", now), suggestions: [] };
  const after = { entries: addToDictionary(before.entries, "Harishekhar", ["Hari Shekhar"], "learned", now), suggestions: [] };
  const current = { entries: addToDictionary(after.entries, "YULU", ["YOLO"], "learned", now), suggestions: [] };
  const undone = undoDictionaryChange(current, before, after);
  assert.deepEqual(undone.entries.map(e => e.right), ["Figma", "YULU"]);
  const edited = { entries: addToDictionary(after.entries, "Harishekhar", ["Another spelling"], "manual", now), suggestions: [] };
  assert.throws(() => undoDictionaryChange(edited, before, after), /changed since learning/);
  assert.equal(edited.entries.at(-1).wrong.length, 2);
});

test("native classification learns lowercase spellings but rejects unrelated replacements", () => {
  const base = { correctionId: 'native-1', transcriptId: 't', timestamp: now, source: 'observed',
    engine: 'local', modelName: 'm', language: 'en', wordCount: 10, changedRatio: 0.2, rewrite: false };
  for (const [from, to] of [['Jolo', 'yolo'], ['Figna', 'Figma'], ['YOLO', 'YULU'],
    ['Hari Shekhar', 'Harishekhar'], ['recieve', 'receive']]) {
    const suggestions = suggestionsFromCorrection({ ...base, pairs: [{ kind: 'substitution', from, to }] }, [], []);
    assert.equal(suggestions.length, 1, `${from} → ${to}`);
    assert.equal(isSuggestionReady(suggestions[0]), true, 'One verified session suffices');
  }
  for (const [from, to] of [['red', 'blue'], ['Monday', 'Friday'], ['Alice', 'Robert'],
    ['dog', 'cat'], ['the', 'Tauri'], ['first draft', 'final version']]) {
    assert.deepEqual(suggestionsFromCorrection({ ...base, pairs: [{ kind: 'substitution', from, to }] }, [], []), [], `${from} → ${to}`);
  }
  const existing = addToDictionary([], 'YULU', ['Jolo'], 'manual', now);
  assert.deepEqual(suggestionsFromCorrection({ ...base, pairs: [{ kind: 'substitution', from: 'Jolo', to: 'yolo' }] }, [], existing), [], 'Native learning cannot introduce competing replacement rules');
});
