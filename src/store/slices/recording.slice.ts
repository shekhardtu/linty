import type { StateCreator } from "zustand";

export interface RecordingSlice {
  isRecording: boolean;
  recordingDuration: number;
  handsFree: boolean;
  quietSeconds: number;
  recordingGeneration: number;
  pendingDictations: number;
  beginProcessing: () => void;
  finishProcessing: () => void;
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
  pendingDictations: 0,
  beginProcessing: () => set((state) => ({ pendingDictations: state.pendingDictations + 1 })),
  finishProcessing: () => set((state) => ({ pendingDictations: Math.max(0, state.pendingDictations - 1) })),
  setHandsFree: (handsFree) => set({ handsFree }),
  setQuietSeconds: (quietSeconds) => set({ quietSeconds }),
  setRecordingGeneration: (recordingGeneration) => set({ recordingGeneration }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setRecordingDuration: (recordingDuration) => set({ recordingDuration }),
  resetRecording: () =>
    set({ isRecording: false, recordingDuration: 0, handsFree: false, quietSeconds: 0, recordingGeneration: 0 }),
});
