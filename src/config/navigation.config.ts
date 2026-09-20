import {
  BarChart3,
  BookOpen,
  Clock,
  Info,
  Keyboard,
  Layers3,
  Mic,
  Palette,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

/** Shared by navigation, command search, the toolbar, and page introductions. */
export const NAVIGATION_ITEMS = [
  {
    id: "dashboard",
    label: "Overview",
    title: "Your dictation",
    artwork: "flow",
    description: "Your recent words and activity, at a glance.",
    group: "workspace",
    icon: BarChart3,
    keywords: "stats overview analytics words",
  },
  {
    id: "history",
    label: "History",
    title: "Your words",
    artwork: "contour",
    description: "Everything you’ve said, ready to find again.",
    group: "workspace",
    icon: Clock,
    keywords: "transcripts past recordings search",
  },
  {
    id: "apps",
    label: "Apps",
    title: "Words, everywhere",
    artwork: "flow",
    description: "See where dictation makes room in your day.",
    group: "workspace",
    icon: Layers3,
    keywords: "applications usage statistics time",
  },
  {
    id: "dictionary",
    label: "Dictionary",
    title: "Dictionary",
    artwork: "contour",
    description: "Names, terms, and spellings that deserve to be right.",
    group: "workspace",
    icon: BookOpen,
    keywords: "vocabulary corrections words learn spelling names",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    title: "A shortcut to your words",
    artwork: "flow",
    description:
      "Choose a dictation trigger and navigate Linty from your keyboard.",
    group: "setup",
    icon: Keyboard,
    keywords: "hotkeys keys bindings push-to-talk fn hold quit",
  },
  {
    id: "system-check",
    label: "System Check",
    title: "Ready when you are",
    artwork: "contour",
    description: "Check your permissions and try a short recording.",
    group: "setup",
    icon: ShieldCheck,
    keywords: "permissions microphone accessibility diagnostics test",
  },
  {
    id: "settings",
    label: "Settings",
    title: "Settings",
    artwork: "contour",
    description: "Make Linty work for you.",
    group: "setup",
    icon: Settings,
    keywords: "preferences configuration",
  },
  {
    id: "about",
    label: "About",
    title: "About Linty",
    artwork: "contour",
    description: "A little less typing. A little more flow.",
    group: "setup",
    icon: Info,
    keywords:
      "version check for updates install update website github licenses",
  },
] as const;

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "Dictation",
    description: "Choose how Linty listens and writes.",
    icon: Sparkles,
    keywords:
      "language languages english hindi auto-detect spoken multilingual speech support model whisper parakeet refine transcription grammar punctuation correction instructions clipboard paste output reformat s1 mini Superwhisper local cleanup lists memory idle",
  },
  {
    id: "audio",
    label: "Audio",
    description: "Your microphone and recording quality.",
    icon: Mic,
    keywords: "input device mic source sample quality rate khz",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "A familiar workspace, in your preferred light.",
    icon: Palette,
    keywords: "theme dark light system accent color",
  },
  {
    id: "privacy",
    label: "Privacy & storage",
    description: "Understand and control what Linty saves.",
    icon: Shield,
    keywords:
      "history retention storage location attribution dictionary learning corrections audio recording voice save consent privacy local processing",
  },
] as const;

export type AppView = (typeof NAVIGATION_ITEMS)[number]["id"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
export const getPageDefinition = (id: AppView) =>
  NAVIGATION_ITEMS.find((page) => page.id === id)!;
