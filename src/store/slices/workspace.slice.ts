import type { StateCreator } from "zustand";
import type { UsagePeriod } from "@/lib/usage.util";

export type ApplicationSort = "words" | "seconds" | "sessions" | "lastUsedAt";
export type UsageView = "dashboard" | "apps";
export interface DictionaryDraft {
  right: string;
  wrong: string;
}

/** Working context survives navigation, but never writes unfinished text to disk. */
export interface WorkspaceSlice {
  applicationSort: ApplicationSort;
  setApplicationSort: (sort: ApplicationSort) => void;
  usagePeriods: Record<UsageView, UsagePeriod>;
  setUsagePeriod: (view: UsageView, period: UsagePeriod) => void;
  dictionaryDraft: DictionaryDraft;
  setDictionaryDraft: (patch: Partial<DictionaryDraft>) => void;
  clearDictionaryDraft: (saved: DictionaryDraft) => void;
}

export const createWorkspaceSlice: StateCreator<WorkspaceSlice> = (set) => ({
  applicationSort: "words",
  setApplicationSort: (applicationSort) => set({ applicationSort }),
  usagePeriods: { dashboard: "7d", apps: "30d" },
  setUsagePeriod: (view, period) => set((state) => ({
    usagePeriods: { ...state.usagePeriods, [view]: period },
  })),
  dictionaryDraft: { right: "", wrong: "" },
  setDictionaryDraft: (patch) => set((state) => ({
    dictionaryDraft: { ...state.dictionaryDraft, ...patch },
  })),
  // A slow save must not erase a newer draft typed while it was in flight.
  clearDictionaryDraft: (saved) => set((state) =>
    state.dictionaryDraft === saved
      ? { dictionaryDraft: { right: "", wrong: "" } }
      : state,
  ),
});
