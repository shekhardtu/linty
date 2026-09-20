import { isWordBoundaryCorrection, normalizeWord } from "./correction-diff.util.ts";

/** Conservative, local spelling evidence. Capitalization alone is not evidence
 * that a replacement should be repeated forever. This does not infer semantics. */
export function isSpellingCorrection(from: string, to: string): boolean {
  const a = normalizeWord(from).normalize("NFC");
  const b = normalizeWord(to).normalize("NFC");
  if (isWordBoundaryCorrection(a, b)) return true;
  if (!/^[\p{L}\p{M}]+$/u.test(a) || !/^[\p{L}\p{M}]+$/u.test(b)) return false;
  const left = [...a], right = [...b];
  if (Math.min(left.length, right.length) < 4 || Math.max(left.length, right.length) > 64) return false;
  if (a === b) return from !== to;
  const rows: number[][] = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  rows[0] = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
      rows[i - 1][j - 1] + Number(left[i - 1] !== right[j - 1]));
    if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
      rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  const distance = rows[left.length][right.length];
  if (distance <= 2 && distance / Math.max(left.length, right.length) <= 0.4) return true;
  // Vowel-only spelling corrections such as YOLO → YULU. Deliberately
  // restricted to Latin letters; this rule is not a phonetic model.
  if (/^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && distance <= 2) {
    const consonants = (word: string) => word.replace(/[aeiou]/g, "");
    return consonants(a).length >= 2 && consonants(a) === consonants(b);
  }
  return false;
}
