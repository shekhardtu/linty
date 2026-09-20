import type { CorrectionPair } from "../types/correction.types";

/** Above this share of changed words a correction is a rewrite and is not learned from. */
export const REWRITE_THRESHOLD = 0.4;

/** Lower-case, punctuation-stripped form used to compare words. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Whitespace-separated tokens; punctuation stays attached to its word. */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** A name split or joined by the recognizer, e.g. Hari Shekhar → Harishekhar.
 * Limit this to one word versus two or three, with the same letters, so an
 * ordinary multi-word rewrite cannot become an automatic replacement. */
export function isWordBoundaryCorrection(from: string, to: string): boolean {
  const before = tokenize(normalizeWord(from));
  const after = tokenize(normalizeWord(to));
  if (before.length === after.length || Math.min(before.length, after.length) !== 1
    || Math.max(before.length, after.length) > 3) return false;
  return [...before, ...after].every((word) => /^[\p{L}\p{M}\p{N}]+$/u.test(word))
    && before.join("") === after.join("");
}

/**
 * Word-level diff between two texts (longest common subsequence). Adjacent runs
 * of deletions and insertions of equal length are paired one to one, because
 * they are almost always word-for-word fixes; unequal runs become one pair.
 */
export function wordDiff(before: string, after: string): CorrectionPair[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > 2000 || b.length > 2000) return [];
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairs: CorrectionPair[] = [];
  let dels: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (dels.length && ins.length) {
      if (dels.length === ins.length) {
        dels.forEach((from, k) => pairs.push({ kind: "substitution", from, to: ins[k] }));
      } else {
        pairs.push({ kind: "substitution", from: dels.join(" "), to: ins.join(" ") });
      }
    } else if (dels.length) {
      pairs.push({ kind: "deletion", from: dels.join(" "), to: "" });
    } else if (ins.length) {
      pairs.push({ kind: "insertion", from: "", to: ins.join(" ") });
    }
    dels = [];
    ins = [];
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      dels.push(a[i++]);
    } else {
      ins.push(b[j++]);
    }
  }
  while (i < n) dels.push(a[i++]);
  while (j < m) ins.push(b[j++]);
  flush();
  return pairs;
}

export interface CorrectionDiff {
  pairs: CorrectionPair[];
  wordCount: number;
  changedRatio: number;
  rewrite: boolean;
}

/** Judge a set of changes: how much of the pasted text moved, and whether that makes it a rewrite. */
export function judgeCorrection(pairs: CorrectionPair[], wordCount: number): { changedRatio: number; rewrite: boolean } {
  const changedWords = pairs.reduce(
    (sum, p) => sum + (p.kind === "substitution" && isWordBoundaryCorrection(p.from, p.to)
      ? 1 : Math.max(tokenize(p.from).length, tokenize(p.to).length)),
    0,
  );
  const changedRatio = wordCount ? Math.min(1, changedWords / wordCount) : pairs.length ? 1 : 0;
  return { changedRatio, rewrite: changedRatio > REWRITE_THRESHOLD };
}

/** Diff a pasted text against the person's edit and judge whether it is a fix or a rewrite. */
export function diffCorrection(pasted: string, edited: string): CorrectionDiff {
  const pairs = wordDiff(pasted, edited);
  const wordCount = tokenize(pasted).length;
  return { pairs, wordCount, ...judgeCorrection(pairs, wordCount) };
}
