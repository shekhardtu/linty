import type { StateCreator } from "zustand";
import { DEFAULT_TYPING_SPEED } from "@/lib/payoff.util";
import type { ReformatContext, ReformatStyle } from "@/types/reformat.types";

export type ThemePreference = "light" | "dark" | "system";

/** Sentinel value for the fn-key trigger. */
export const TRIGGER_KEY_FN = "fn";
export const DEFAULT_TRIGGER_KEY = TRIGGER_KEY_FN;
/**
 * triggerKey value formats: TRIGGER_KEY_FN, "modifier:<name>" for a bare
 * modifier hold (right-command, left-option, ...), or a global-shortcut
 * accelerator string ("Command+Shift+Space").
 */
export const MODIFIER_TRIGGER_PREFIX = "modifier:";
/** Registered alongside modifier-hold triggers as an alternate shortcut; also offered as a standalone trigger option. */
export const FALLBACK_TRIGGER_ACCELERATOR = "CommandOrControl+Shift+Space";

export interface TriggerKeyOption {
  value: string;
  label: string;
  display: string;
  description: string;
}

export const TRIGGER_KEY_OPTIONS: TriggerKeyOption[] = [
  {
    value: TRIGGER_KEY_FN,
    label: "fn key",
    display: "fn (hold)",
    description: "Hold the fn key. Requires the macOS fn binding set to \"Do Nothing\".",
  },
  {
    value: `${MODIFIER_TRIGGER_PREFIX}right-command`,
    label: "Right ⌘",
    display: "R⌘ (hold)",
    description: "Hold the right Command key. No macOS conflicts.",
  },
  {
    value: `${MODIFIER_TRIGGER_PREFIX}right-option`,
    label: "Right ⌥",
    display: "R⌥ (hold)",
    description: "Hold the right Option key. No macOS conflicts.",
  },
  {
    value: FALLBACK_TRIGGER_ACCELERATOR,
    label: "⌘⇧Space",
    display: "⌘⇧Space (hold)",
    description: "Hold Command+Shift+Space. Unassigned by macOS by default.",
  },
  {
    value: "Control+Option+Space",
    label: "⌃⌥Space",
    display: "⌃⌥Space (hold)",
    description: "Hold Control+Option+Space. Can conflict if you switch between multiple input sources.",
  },
];

export interface SettingsSlice {
  reformatEnabled: boolean;
  reformatStyle: ReformatStyle;
  reformatLists: boolean;
  reformatContext: ReformatContext;
  setReformatEnabled: (enabled: boolean) => void;
  setReformatStyle: (style: ReformatStyle) => void;
  setReformatLists: (enabled: boolean) => void;
  setReformatContext: (context: ReformatContext) => void;
  localModelPath: string | null;
  isLocalModelDownloaded: boolean;
  theme: ThemePreference;
  whisperPrompt: string;
  onboardingComplete: boolean;
  transcriptionLanguage: string;
  autoDetectLanguages: string[];
  loadedModelFilename: string | null;
  selectedModelFilename: string | null;
  /** Apply the personal dictionary (replacements + engine hints) to new dictations. */
  dictionaryEnabled: boolean;
  /** Promote ready suggestions into the dictionary without asking. */
  autoLearnWords: boolean;
  /** After a paste, watch the target field (Accessibility API) for fixes to the pasted text. */
  observeCorrections: boolean;
  /** Minutes of inactivity before the local model is unloaded (0 = never). */
  modelIdleUnloadMinutes: number;
  /** Push-to-talk trigger: TRIGGER_KEY_FN or a global-shortcut accelerator string. */
  triggerKey: string;
  settingsLoaded: boolean;
  trackApplicationUsage: boolean;
  typingWordsPerMinute: number;
  setTypingWordsPerMinute: (speed: number) => void;
  setTrackApplicationUsage: (enabled: boolean) => void;
  setLoadedModelFilename: (filename: string | null) => void;
  setSelectedModelFilename: (filename: string | null) => void;
  setLocalModelPath: (path: string | null) => void;
  setIsLocalModelDownloaded: (downloaded: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  setWhisperPrompt: (prompt: string) => void;
  setOnboardingComplete: (complete: boolean) => void;
  setTranscriptionLanguage: (language: string) => void;
  setModelIdleUnloadMinutes: (minutes: number) => void;
  setDictionaryEnabled: (enabled: boolean) => void;
  setAutoLearnWords: (enabled: boolean) => void;
  setObserveCorrections: (enabled: boolean) => void;
  setTriggerKey: (triggerKey: string) => void;
  setSettingsLoaded: (loaded: boolean) => void;
}

export const DEFAULT_MODEL_IDLE_UNLOAD_MINUTES = 15;

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  reformatEnabled: false,
  reformatStyle: "semi-formal",
  reformatLists: true,
  reformatContext: "auto",
  setReformatEnabled: (reformatEnabled) => set({ reformatEnabled }),
  setReformatStyle: (reformatStyle) => set({ reformatStyle }),
  setReformatLists: (reformatLists) => set({ reformatLists }),
  setReformatContext: (reformatContext) => set({ reformatContext }),
  localModelPath: null,
  isLocalModelDownloaded: false,
  theme: "system",
  whisperPrompt: "",
  onboardingComplete: false,
  transcriptionLanguage: "auto",
  autoDetectLanguages: [],
  loadedModelFilename: null,
  selectedModelFilename: null,
  modelIdleUnloadMinutes: DEFAULT_MODEL_IDLE_UNLOAD_MINUTES,
  dictionaryEnabled: true,
  autoLearnWords: false,
  observeCorrections: false,
  triggerKey: DEFAULT_TRIGGER_KEY,
  settingsLoaded: false,
  trackApplicationUsage: true,
  typingWordsPerMinute: DEFAULT_TYPING_SPEED,
  setTypingWordsPerMinute: (typingWordsPerMinute) => set({typingWordsPerMinute}),
  setTrackApplicationUsage: (trackApplicationUsage) => set({ trackApplicationUsage }),
  setLoadedModelFilename: (loadedModelFilename) => set({ loadedModelFilename }),
  setSelectedModelFilename: (selectedModelFilename) => set({ selectedModelFilename }),
  setLocalModelPath: (localModelPath) => set({ localModelPath }),
  setIsLocalModelDownloaded: (isLocalModelDownloaded) =>
    set({ isLocalModelDownloaded }),
  setTheme: (theme) => set({ theme }),
  setWhisperPrompt: (whisperPrompt) => set({ whisperPrompt }),
  setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
  setTranscriptionLanguage: (transcriptionLanguage) => set({ transcriptionLanguage }),
  setModelIdleUnloadMinutes: (modelIdleUnloadMinutes) => set({ modelIdleUnloadMinutes }),
  setDictionaryEnabled: (dictionaryEnabled) => set({ dictionaryEnabled }),
  setAutoLearnWords: (autoLearnWords) => set({ autoLearnWords }),
  setObserveCorrections: (observeCorrections) => set({ observeCorrections }),
  setTriggerKey: (triggerKey) => set({ triggerKey }),
  setSettingsLoaded: (settingsLoaded) => set({ settingsLoaded }),
});
