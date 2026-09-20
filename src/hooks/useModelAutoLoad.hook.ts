import { useEffect } from "react";
import { useAppStore } from "@/store/app.store";
import { prepareLanguage } from "@/services/language-preparation.service";

/** Startup follows the language policy; onboarding owns first-run preparation. */
export function useModelAutoLoad() {
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const onboardingComplete = useAppStore((s) => s.onboardingComplete);
  useEffect(() => {
    if (!settingsLoaded || !onboardingComplete) return;
    void prepareLanguage(useAppStore.getState().transcriptionLanguage).catch((error) => {
      useAppStore.getState().addToast({ type: "error", message: `Could not prepare dictation. Open Settings → Dictation to retry. ${String(error)}` });
    });
  }, [settingsLoaded, onboardingComplete]);
}
