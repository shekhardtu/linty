import type { StateCreator } from "zustand";

export type TranscriptionStatus =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "correcting"
  | "pasting"
  | "done"
  | "error";

export interface TranscriptionSlice {
  status: TranscriptionStatus;
  rawTranscript: string;
  correctedTranscript: string;
  finalText: string;
  error: string | null;
  setStatus: (status: TranscriptionStatus) => void;
  setRawTranscript: (text: string) => void;
  setCorrectedTranscript: (text: string) => void;
  setFinalText: (text: string) => void;
  setError: (error: string | null) => void;
  resetTranscription: () => void;
}

export const createTranscriptionSlice: StateCreator<TranscriptionSlice> = (
  set,
) => ({
  status: "idle",
  rawTranscript: "",
  correctedTranscript: "",
  finalText: "",
  error: null,
  setStatus: (status) => set({ status }),
  setRawTranscript: (rawTranscript) => set({ rawTranscript }),
  setCorrectedTranscript: (correctedTranscript) => set({ correctedTranscript }),
  setFinalText: (finalText) => set({ finalText }),
  setError: (error) => set({ error, status: error ? "error" : "idle" }),
  resetTranscription: () =>
    set({
      status: "idle",
      rawTranscript: "",
      correctedTranscript: "",
      finalText: "",
      error: null,
    }),
});
