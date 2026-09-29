import type { StateCreator } from "zustand";
import type { UpdateNotice } from "@/lib/update-acknowledgment";

/**
 * `waiting`: a required update is downloaded and installs once dictation has
 * been quiet for a while. `installing`: it is being installed.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "waiting"
  | "verifying"
  | "installing"
  | "restarting"
  | "error";

export interface UpdaterSlice {
  installedVersion: string | null;
  updateNotice: UpdateNotice | null;
  updateNotes: string | null;
  /** Last successful check with no newer release; cleared on an offer or failure. */
  updateCheckedAt: number | null;
  updateStatus: UpdateStatus;
  updateVersion: string | null;
  updateCurrentVersion: string | null;
  /** The offered update is required (latest.json minimum_version). */
  updateRequired: boolean;
  updateNoticeDismissed: boolean;
  updateRestartAt: number | null;
  updateRestartPending: boolean;
  updateError: string | null;
  updateProgress: number;
  setUpdateStatus: (status: UpdateStatus) => void;
  setUpdateVersion: (version: string | null) => void;
  setUpdateCurrentVersion: (version: string | null) => void;
  setUpdateRequired: (required: boolean) => void;
  setUpdateError: (error: string | null) => void;
  setUpdateProgress: (progress: number) => void;
}

export const createUpdaterSlice: StateCreator<UpdaterSlice> = (set) => ({
  installedVersion: null,
  updateNotice: null,
  updateNotes: null,
  updateCheckedAt: null,
  updateStatus: "idle",
  updateVersion: null,
  updateCurrentVersion: null,
  updateRequired: false,
  updateNoticeDismissed: false,
  updateRestartAt: null,
  updateRestartPending: false,
  updateError: null,
  updateProgress: 0,
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setUpdateVersion: (updateVersion) => set({ updateVersion }),
  setUpdateCurrentVersion: (updateCurrentVersion) => set({ updateCurrentVersion }),
  setUpdateRequired: (updateRequired) => set({ updateRequired }),
  setUpdateError: (updateError) => set({ updateError }),
  setUpdateProgress: (updateProgress) => set({ updateProgress }),
});
