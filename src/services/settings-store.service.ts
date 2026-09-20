import { load } from "@tauri-apps/plugin-store";
import { useAppStore } from "@/store/app.store";
import { DEFAULT_MODEL_IDLE_UNLOAD_MINUTES, DEFAULT_TRIGGER_KEY } from "@/store/slices/settings.slice";
import type { SettingsSlice } from "@/store/slices/settings.slice";
import { DEFAULT_TYPING_SPEED } from "@/lib/payoff.util";
import { saveSettingsChange } from "@/lib/settings-save-feedback";

const STORE_PATH = "linty-settings.json";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

export async function getSettingsStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_PATH, {
      defaults: {
        reformatEnabled: false,
        reformatStyle: "semi-formal",
        reformatLists: true,
        reformatContext: "auto",
        theme: "system",
        whisperPrompt: "",
        modelIdleUnloadMinutes: DEFAULT_MODEL_IDLE_UNLOAD_MINUTES,
        triggerKey: DEFAULT_TRIGGER_KEY,
        trackApplicationUsage: true,
        typingWordsPerMinute: DEFAULT_TYPING_SPEED,
        dictionaryEnabled: true,
        autoLearnWords: false,
        observeCorrections: false,
      },
      autoSave: true,
    });
  }
  return storeInstance;
}

/** Persist first, and only report success once the write reaches disk. */
export function saveSetting<K extends keyof SettingsSlice>(key: K, value: SettingsSlice[K]) {
  return saveSettingsChange(key, async () => {
    const store = await getSettingsStore();
    const previous = useAppStore.getState()[key];
    try {
      await store.set(key, value);
      await store.save();
    } catch (error) {
      await store.set(key, previous).catch(() => {});
      throw error;
    }
    useAppStore.setState({ [key]: value });
  });
}

