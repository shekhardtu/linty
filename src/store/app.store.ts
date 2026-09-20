import { create } from "zustand";
import { createWorkspaceSlice, type WorkspaceSlice } from "./slices/workspace.slice";
import {
  createRecordingSlice,
  type RecordingSlice,
} from "./slices/recording.slice";
import {
  createTranscriptionSlice,
  type TranscriptionSlice,
} from "./slices/transcription.slice";
import {
  createSettingsSlice,
  type SettingsSlice,
} from "./slices/settings.slice";
import {
  createNavigationSlice,
  type NavigationSlice,
} from "./slices/navigation.slice";
import {
  createHistorySlice,
  type HistorySlice,
} from "./slices/history.slice";
import {
  createToastSlice,
  type ToastSlice,
} from "./slices/toast.slice";
import {
  createUpdaterSlice,
  type UpdaterSlice,
} from "./slices/updater.slice";
import {
  createDictionarySlice,
  type DictionarySlice,
} from "./slices/dictionary.slice";

export type AppStore = RecordingSlice &
  TranscriptionSlice &
  SettingsSlice &
  NavigationSlice &
  HistorySlice &
  ToastSlice &
  UpdaterSlice &
  DictionarySlice &
  WorkspaceSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createRecordingSlice(...a),
  ...createTranscriptionSlice(...a),
  ...createSettingsSlice(...a),
  ...createNavigationSlice(...a),
  ...createHistorySlice(...a),
  ...createToastSlice(...a),
  ...createUpdaterSlice(...a),
  ...createDictionarySlice(...a),
  ...createWorkspaceSlice(...a),
}));
