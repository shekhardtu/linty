import type { StateCreator } from "zustand";
import type { TranscriptRecord } from "@/types/transcript.types";
import type { HistorySnapshot } from "@/types/history.types";

export interface HistorySlice {
  /** A bounded recent cache for the tray and correction observer, never the archive. */
  transcripts: TranscriptRecord[];
  historySnapshot: HistorySnapshot;
  historyLoaded: boolean;
  historyError: string | null;
  historyCacheEpoch: number;
  invalidateHistoryCache: () => void;
  searchQuery: string;
  selectedTranscriptId: string | null;
  setHistorySnapshot: (snapshot: HistorySnapshot) => void;
  setHistoryError: (error: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedTranscriptId: (id: string | null) => void;
}
export const createHistorySlice: StateCreator<HistorySlice> = (set) => ({
  transcripts: [],
  historySnapshot: {
    recent: [],
    total: 0,
    oldestTimestamp: null,
    totalWords: 0,
    milestone: null,
    correctionCount: 0,
    correctionRate: null,
    retentionDays: 0,
    saveAudio: false,
    audioCount: 0,
    audioBytes: 0,
    revision: 0,
  },
  historyLoaded: false,
  historyError: null,
  historyCacheEpoch: 0,
  invalidateHistoryCache: () => set((state) => ({
    historyCacheEpoch: state.historyCacheEpoch + 1,
    transcripts: [],
    historySnapshot: { ...state.historySnapshot, recent: [] },
    historyLoaded: false,
  })),
  searchQuery: "",
  selectedTranscriptId: null,
  setHistorySnapshot: (historySnapshot) =>
    set((state) =>
      state.historyLoaded &&
      state.historySnapshot.revision === historySnapshot.revision
        ? { historyLoaded: true, historyError: null }
        : {
            historySnapshot,
            transcripts: historySnapshot.recent,
            historyLoaded: true,
            historyError: null,
          },
    ),
  setHistoryError: (historyError) => set({ historyError }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSelectedTranscriptId: (selectedTranscriptId) =>
    set({ selectedTranscriptId }),
});
