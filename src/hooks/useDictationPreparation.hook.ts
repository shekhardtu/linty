import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { dictationPreparation, prepareDictation } from "@/services/dictation-preparation.service";
import { modelSupportsLanguage } from "@/lib/languages.util";

export function useDictationPreparation() {
  const { settingsLoaded, onboardingComplete, loadedModelFilename, transcriptionLanguage, reformatEnabled, dictionaryEnabled } = useAppStore();
  const hasWords = useAppStore((s) => s.dictionaryEntries.some((entry) => entry.enabled));
  useEffect(() => {
    if (!settingsLoaded || !onboardingComplete || !modelSupportsLanguage(loadedModelFilename, transcriptionLanguage)) return;
    const prepare = () => {
      const state = useAppStore.getState();
      if (state.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) return;
      void prepareDictation().catch((error) => console.warn("[dictation] Preparation failed:", error));
    };
    prepare();
    const idle = listen("model-idle-unloaded", () => dictationPreparation.invalidate());
    const wake = listen("system-wake", () => { dictationPreparation.invalidate(); prepare(); });
    // Opening the app after idle gives preparation a head start. Do not reload
    // immediately on the unload event, which would defeat the memory setting.
    const focus = () => { if (dictationPreparation.getSnapshot() === "idle") prepare(); };
    window.addEventListener("focus", focus);
    return () => {
      void idle.then((off) => off());
      void wake.then((off) => off());
      window.removeEventListener("focus", focus);
    };
  }, [settingsLoaded, onboardingComplete, loadedModelFilename, transcriptionLanguage, reformatEnabled, dictionaryEnabled, hasWords]);
}
