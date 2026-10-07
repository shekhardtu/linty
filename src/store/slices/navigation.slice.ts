import type { StateCreator } from "zustand";
import type { HistorySlice } from "./history.slice";

import type { AppView, SettingsSection, SettingTarget } from "@/config/navigation.config";
export type { AppView, SettingsSection } from "@/config/navigation.config";
export { SETTINGS_SECTIONS } from "@/config/navigation.config";

export interface NavigationSlice {
  currentView: AppView;
  settingsSection: SettingsSection;
  settingsTarget: SettingTarget | null;
  sidebarVisible: boolean;
  recordingFocusOpen: boolean;
  setRecordingFocusOpen: (open: boolean) => void;
  setCurrentView: (view: AppView) => void;
  setSettingsSection: (section: SettingsSection, target?: SettingTarget) => void;
  clearSettingsTarget: () => void;
  toggleSidebar: () => void;
}

export const createNavigationSlice: StateCreator<NavigationSlice & Pick<HistorySlice, "selectedTranscriptId">, [], [], NavigationSlice> = (set) => ({
  currentView: "dashboard",
  settingsSection: "general",
  settingsTarget: null,
  sidebarVisible: true,
  recordingFocusOpen: false,
  setRecordingFocusOpen: (recordingFocusOpen) => set({ recordingFocusOpen }),
  // Leave the reader behind on navigation; Overview can select before entering History.
  setCurrentView: (currentView) => set((state) => ({
    currentView,
    ...(state.currentView === "history" && currentView !== "history" ? { selectedTranscriptId: null } : {}),
  })),
  setSettingsSection: (settingsSection, target) => set({ settingsSection, settingsTarget: target ?? null, currentView: "settings", selectedTranscriptId: null }),
  clearSettingsTarget: () => set({ settingsTarget: null }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
});
