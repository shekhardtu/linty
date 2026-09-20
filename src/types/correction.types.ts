import type { ApplicationIdentity } from "./transcript.types";

/** Where a correction was observed: an edit inside Linty, or a change seen in the target app. */
export type CorrectionSource = "edit" | "observed";

export type CorrectionKind = "substitution" | "insertion" | "deletion";

/** One word-level change between the text Linty pasted and what the person ended up with. */
export interface CorrectionPair {
  kind: CorrectionKind;
  /** Text as pasted (empty for insertions). */
  from: string;
  /** Text after the fix (empty for deletions). */
  to: string;
}

/** A correction the person made to one dictation. Stored in the local history database. */
export interface CorrectionRecord {
  correctionId: string;
  transcriptId: string;
  timestamp: number;
  source: CorrectionSource;
  engine: string;
  modelName: string;
  language: string;
  application?: ApplicationIdentity | null;
  /** Words in the text as pasted; the denominator for corrections per 100 words. */
  wordCount: number;
  /** Share of pasted words that changed (0–1). */
  changedRatio: number;
  /** True when so much changed that this is a rewrite, not a fix; never learned from. */
  rewrite: boolean;
  pairs: CorrectionPair[];
}

export type DictionaryOrigin = "manual" | "learned" | "imported";

/** A word Linty should get right: the correct form plus the misspellings that map to it. */
export interface DictionaryEntry {
  entryId: string;
  right: string;
  wrong: string[];
  enabled: boolean;
  origin: DictionaryOrigin;
  /** Times Linty replaced a misheard spelling after transcription ("Corrected"). */
  timesApplied: number;
  /** Times the engine produced the right word because the dictionary was handed to it ("Recognised"). */
  timesRecognized?: number;
  createdAt: number;
  lastAppliedAt?: number;
}

/** A wrong → right pair seen in corrections but not yet confirmed into the dictionary. */
export interface DictionarySuggestion {
  suggestionId: string;
  right: string;
  wrong: string;
  seenCount: number;
  /** Verified native session plus a conservative local spelling classification. */
  spellingEvidence?: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  correctionIds: string[];
}
