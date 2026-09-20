import { useEffect } from "react";
import { useAppStore } from "@/store/app.store";
import { prepareLanguage } from "@/services/language-preparation.service";

/** Prepare defaults while onboarding handles permissions, or load saved choices. */
export function useModelAutoLoad() {
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  useEffect(() => {
    if (!settingsLoaded) return;
    const state = useAppStore.getState();
    void prepareLanguage(state.transcriptionLanguage, {
      applyCleanupDefault: !state.onboardingComplete && !state.selectedModelFilename,
    }).catch((error) => {
      useAppStore.getState().addToast({ type: "error", message: `Could not prepare dictation. Open Settings → Dictation to retry. ${String(error)}` });
    });
  }, [settingsLoaded]);
}
