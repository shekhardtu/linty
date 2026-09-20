import type { TranscriptRecord } from "./transcript.types";
import type { CorrectionRecord } from "./correction.types";
import type {
  ApplicationUsage,
  summarizeUsage,
  usageTimeline,
} from "@/lib/usage.util";

export type HistoryRetention = 0 | 30 | 90 | 365;
export interface HistorySnapshot {
  recent: TranscriptRecord[];
  total: number;
  oldestTimestamp: number | null;
  totalWords: number;
  milestone: { words: number; timestamp: number } | null;
  correctionCount: number;
  correctionRate: number | null;
  retentionDays: HistoryRetention;
  saveAudio: boolean;
  audioCount: number;
  audioBytes: number;
  revision: number;
}
export interface HistoryPageResult {
  records: TranscriptRecord[];
  total: number;
}
export interface DeletedTranscript {
  transcript: TranscriptRecord;
  corrections: CorrectionRecord[];
  generation: number;
}
export interface UsageTiming {
  words: number;
  seconds: number;
  processingSeconds: number;
  sessions: number;
  missingSessions: number;
}
export interface UsageSummary {
  stats: ReturnType<typeof summarizeUsage>;
  timing: UsageTiming;
  activeDays: number;
}
export interface UsageResult extends UsageSummary {
  applications: ApplicationUsage[];
  timeline: ReturnType<typeof usageTimeline>;
  recent: TranscriptRecord[];
  engines: {
    engine: string;
    sessions: number;
    share: number | null;
    rate: number | null;
  }[];
}
