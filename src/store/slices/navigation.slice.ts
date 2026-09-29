import type { StateCreator } from "zustand";
import type { HistorySlice } from "./history.slice";

import type { AppView, SettingsSection } from "@/config/navigation.config";
export type { AppView, SettingsSection } from "@/config/navigation.config";
export { SETTINGS_SECTIONS } from "@/config/navigation.config";

export interface NavigationSlice {
  currentView: AppView;
  settingsSection: SettingsSection;
  sidebarVisible: boolean;
  recordingFocusOpen: boolean;
  setRecordingFocusOpen: (open: boolean) => void;
  setCurrentView: (view: AppView) => void;
  setSettingsSection: (section: SettingsSection) => void;
  toggleSidebar: () => void;
}

export const createNavigationSlice: StateCreator<NavigationSlice & Pick<HistorySlice, "selectedTranscriptId">, [], [], NavigationSlice> = (set) => ({
  currentView: "dashboard",
  settingsSection: "general",
  sidebarVisible: true,
  recordingFocusOpen: false,
  setRecordingFocusOpen: (recordingFocusOpen) => set({ recordingFocusOpen }),
  // Leave the reader behind on navigation; Overview can select before entering History.
  setCurrentView: (currentView) => set((state) => ({
    currentView,
    ...(state.currentView === "history" && currentView !== "history" ? { selectedTranscriptId: null } : {}),
  })),
  setSettingsSection: (settingsSection) => set({ settingsSection, currentView: "settings", selectedTranscriptId: null }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
});
