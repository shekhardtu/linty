import type { ReformatMetrics } from "./reformat.types";

export interface ApplicationIdentity {
  name: string;
  bundleId: string | null;
}

export interface TranscriptRecord {
  transcriptId: string;
  rawText: string;
  finalText: string;
  /** Immutable output from S1-mini, before dictionary replacements or user edits. */
  reformattedText?: string;
  /** Immutable delivered text; finalText may subsequently be edited in History. */
  pastedText?: string;
  reformatting?: ReformatMetrics;
  reformatTimeMs?: number;
  transcriptionLanguage?: string;
  speechModelId?: string;
  audioSampleCount?: number;
  /** Present only when this dictation has an opt-in, locally saved recording. */
  audio?: { format: "wav"; sampleRate: number; channels: number; bitsPerSample: number; bytes: number };
  /** Legacy pasted means command posted, not verified insertion. */
  deliveryStatus?: "pasted" | "pending" | "verified" | "unverified" | "failed" | "skipped";
  attemptedText?: string;
  delivery?: { status: string; commandPosted: boolean; commandPostedMs: number | null; insertionObservedMs: number | null; reason: string | null };
  textValidation?: { status: "unchanged" | "accepted" | "fallback"; reasons: string[] };
  dictionaryValidation?: string[];
  /** Native stop request to observed insertion; absent when unverified. */
  releaseToInsertionMs?: number | null;
  audioStopTimeMs?: number;
  preparationTimeMs?: number;
  originalWordCount?: number;
  engine: string;
  modelName: string;
  durationSeconds: number;
  processingTimeMs: number;
  sttTimeMs?: number;
  correctionTimeMs?: number;
  pasteTimeMs?: number;
  wordCount: number;
  timestamp: number;
  corrected: boolean;
  /** Foreground app when dictation started; absent for older/private sessions. */
  application?: ApplicationIdentity | null;
  /** Dictionary replacements applied before paste, as wrong → right pairs. */
  dictionaryApplied?: { from: string; to: string }[];
}

export interface UsageStats {
  totalTranscriptions: number;
  totalRecordingSeconds: number;
  totalProcessingMs: number;
  successCount: number;
  errorCount: number;
  localCount: number;
  totalWords: number;
}
