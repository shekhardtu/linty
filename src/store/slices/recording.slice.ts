import type { StateCreator } from "zustand";

export interface RecordingSlice {
  isRecording: boolean;
  recordingDuration: number;
  handsFree: boolean;
  quietSeconds: number;
  recordingGeneration: number;
  setHandsFree: (handsFree: boolean) => void;
  setQuietSeconds: (quietSeconds: number) => void;
  setRecordingGeneration: (recordingGeneration: number) => void;
  setIsRecording: (recording: boolean) => void;
  setRecordingDuration: (duration: number) => void;
  resetRecording: () => void;
}

export const createRecordingSlice: StateCreator<RecordingSlice> = (set) => ({
  isRecording: false,
  recordingDuration: 0,
  handsFree: false,
  quietSeconds: 0,
  recordingGeneration: 0,
  setHandsFree: (handsFree) => set({ handsFree }),
  setQuietSeconds: (quietSeconds) => set({ quietSeconds }),
  setRecordingGeneration: (recordingGeneration) => set({ recordingGeneration }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setRecordingDuration: (recordingDuration) => set({ recordingDuration }),
  resetRecording: () =>
    set({ isRecording: false, recordingDuration: 0, handsFree: false, quietSeconds: 0, recordingGeneration: 0 }),
});
