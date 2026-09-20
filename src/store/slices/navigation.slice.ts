import type { StateCreator } from "zustand";

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

export const createNavigationSlice: StateCreator<NavigationSlice> = (set) => ({
  currentView: "dashboard",
  settingsSection: "general",
  sidebarVisible: true,
  recordingFocusOpen: false,
  setRecordingFocusOpen: (recordingFocusOpen) => set({ recordingFocusOpen }),
  setCurrentView: (currentView) => set({ currentView }),
  setSettingsSection: (settingsSection) => set({ settingsSection, currentView: "settings" }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
});
