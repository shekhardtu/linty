import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import { prepareInstalledCleanup } from "@/services/dictation-preparation.service";
import { AUTO_LANGUAGE, DEFAULT_TRANSCRIPTION_LANGUAGE, isSupportedLanguage } from "@/lib/languages.util";
import { DEFAULT_MODEL_IDLE_UNLOAD_MINUTES } from "@/store/slices/settings.slice";
import type { SettingsSlice, ThemePreference } from "@/store/slices/settings.slice";
import type { CleanupMode, ReformatContext, ReformatStyle } from "@/types/reformat.types";

import { saveSettingsChange } from "@/lib/settings-save-feedback";
import { typingSpeed, validTypingSpeed } from "@/lib/payoff.util";

import { getSettingsStore as getStore, saveSetting } from "@/services/settings-store.service";
export { getSettingsStore, saveSetting } from "@/services/settings-store.service";
import { prepareLanguage } from "@/services/language-preparation.service";

export async function saveTypingSpeed(speed: number) {
  if (!validTypingSpeed(speed)) throw new Error("Enter a valid typing speed in words per minute.");
  await saveSetting("typingWordsPerMinute", speed);
}

export function useSettings() {
  const {
    reformatEnabled,
    reformatStyle,
    reformatLists,
    reformatContext,
    theme,
    whisperPrompt,
    onboardingComplete,
    transcriptionLanguage,
    setTheme,
    setWhisperPrompt,
    setOnboardingComplete,
    setTranscriptionLanguage,
    setSelectedModelFilename,
    modelIdleUnloadMinutes,
    setModelIdleUnloadMinutes,
    triggerKey,
    setTriggerKey,
    settingsLoaded,
    setSettingsLoaded,
    trackApplicationUsage,
    setTrackApplicationUsage,
    dictionaryEnabled,
    setDictionaryEnabled,
    autoLearnWords,
    setAutoLearnWords,
    observeCorrections,
    setObserveCorrections,
  } = useAppStore();

  // Load settings on mount
  useEffect(() => {
    if (useAppStore.getState().settingsLoaded) return;
    (async () => {
      try {
        const store = await getStore();
        const reformat = await store.get<boolean>("reformatEnabled");
        const style = await store.get<ReformatStyle>("reformatStyle");
        const lists = await store.get<boolean>("reformatLists");
        const context = await store.get<ReformatContext>("reformatContext");
        useAppStore.setState({
          reformatEnabled: reformat === true,
          reformatStyle: style && ["casual", "semi-casual", "semi-formal", "formal"].includes(style) ? style : "semi-formal",
          reformatLists: lists !== false,
          reformatContext: context && ["auto", "general", "email"].includes(context) ? context : "auto",
        });
        void prepareInstalledCleanup().catch((error) => console.warn("[s1] Startup preparation failed:", error));
        const savedTheme = await store.get<ThemePreference>("theme");
        const savedWhisperPrompt = await store.get<string>("whisperPrompt");
        const savedOnboarding = await store.get<boolean>("onboardingComplete");
        const savedLanguage = await store.get<string>("transcriptionLanguage");
        const savedSelectedModel = await store.get<string>("selectedModelFilename");
        const savedIdleUnload = await store.get<number>("modelIdleUnloadMinutes");
        const savedTriggerKey = await store.get<string>("triggerKey");
        useAppStore.getState().setTypingWordsPerMinute(typingSpeed(await store.get<number>("typingWordsPerMinute")));
        const savedAppTracking = await store.get<boolean>("trackApplicationUsage");
        setTrackApplicationUsage(savedAppTracking ?? true);
        const savedDictionaryEnabled = await store.get<boolean>("dictionaryEnabled");
        setDictionaryEnabled(savedDictionaryEnabled ?? true);
        const savedAutoLearn = await store.get<boolean>("autoLearnWords");
        setAutoLearnWords(savedAutoLearn ?? false);
        const savedObserve = await store.get<boolean>("observeCorrections");
        setObserveCorrections(savedObserve ?? false);

        if (savedTheme) setTheme(savedTheme);
        if (savedWhisperPrompt) setWhisperPrompt(savedWhisperPrompt);
        if (savedOnboarding) setOnboardingComplete(savedOnboarding);
        // Fresh setup defaults to English. Preserve a saved choice (including
        // auto-detect) and the former default for existing users without a language preference.
        const language = savedLanguage
          ? isSupportedLanguage(savedLanguage) ? savedLanguage : AUTO_LANGUAGE
          : savedOnboarding ? AUTO_LANGUAGE : DEFAULT_TRANSCRIPTION_LANGUAGE;
        setTranscriptionLanguage(language);
        if (savedLanguage && language !== savedLanguage) await store.set("transcriptionLanguage", language);
        if (savedSelectedModel) setSelectedModelFilename(savedSelectedModel);
        if (savedTriggerKey) setTriggerKey(savedTriggerKey);

        // 0 is a valid value (never unload) — only fall back when unset
        const idleUnload = savedIdleUnload ?? DEFAULT_MODEL_IDLE_UNLOAD_MINUTES;
        setModelIdleUnloadMinutes(idleUnload);
        // Sync the persisted preference into the Rust watchdog
        invoke("set_model_idle_unload_minutes", { minutes: idleUnload }).catch(() => {});

        setSettingsLoaded(true);
      } catch (err) {
        console.error("Failed to load settings:", err);
        setSettingsLoaded(true);
      }
    })();
  }, [setTheme, setWhisperPrompt, setOnboardingComplete, setTranscriptionLanguage, setSelectedModelFilename, setModelIdleUnloadMinutes, setTriggerKey, setSettingsLoaded, setTrackApplicationUsage, setDictionaryEnabled, setAutoLearnWords, setObserveCorrections]);

  const saveTrackApplicationUsage = useCallback((enabled: boolean) => saveSetting("trackApplicationUsage", enabled), []);
  const saveDictionaryEnabled = useCallback((enabled: boolean) => saveSetting("dictionaryEnabled", enabled), []);
  const saveAutoLearnWords = useCallback((enabled: boolean) => saveSetting("autoLearnWords", enabled), []);
  const saveObserveCorrections = useCallback((enabled: boolean) => saveSetting("observeCorrections", enabled), []);

  const saveCleanupMode = useCallback((mode: CleanupMode) => saveSettingsChange("cleanupMode", async () => {
    const state = useAppStore.getState();
    if (state.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) {
      throw new Error("Finish dictating before changing text cleanup.");
    }
    if (mode === "local") {
      const model = await invoke<{ downloaded: boolean }>("s1_model_status");
      if (!model.downloaded) throw new Error("Download S1-mini before using on-device cleanup.");
      // Do not enable correction until loading and the first inference passes
      // finish; otherwise the user's first dictation pays for GPU initialization.
      await invoke("prepare_s1_model");
      const current = useAppStore.getState();
      if (current.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(current.status)) {
        throw new Error("Finish dictating before changing text cleanup.");
      }
    }
    const store = await getStore();
    const previous = { reformatEnabled: state.reformatEnabled };
    const next = { reformatEnabled: mode === "local" };
    try {
      await store.set("reformatEnabled", next.reformatEnabled);
      await store.save();
    } catch (error) {
      await store.set("reformatEnabled", previous.reformatEnabled).catch(() => {});
      throw error;
    }
    useAppStore.setState(next);
    // Installed S1 stays prepared even when cleanup is off. The shared idle
    // policy releases it later; switching modes must not make it cold again.
  }), []);

  const saveReformatSetting = useCallback(<K extends "reformatStyle" | "reformatLists" | "reformatContext",>(key: K, value: SettingsSlice[K]) => saveSetting(key, value), []);
  const saveTheme = useCallback((value: ThemePreference) => saveSetting("theme", value), []);
  const saveWhisperPrompt = useCallback((value: string) => saveSetting("whisperPrompt", value), []);
  const saveOnboardingComplete = useCallback((value: boolean) => saveSetting("onboardingComplete", value), []);
  const saveTranscriptionLanguage = useCallback(async (value: string) => {
    const state = useAppStore.getState();
    if (state.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status)) {
      throw new Error("Finish dictating before changing the transcription language.");
    }
    if (!isSupportedLanguage(value)) throw new Error("Choose a supported transcription language.");
    if (!state.onboardingComplete) {
      // Save the initial choice immediately so setup can continue while speech
      // support downloads. Later changes commit only after preparation succeeds.
      await saveSetting("transcriptionLanguage", value);
      void prepareLanguage(value).catch(() => {});
    } else {
      await prepareLanguage(value);
    }
  }, []);
  const saveTriggerKey = useCallback((value: string) => saveSetting("triggerKey", value), []);
  const saveModelIdleUnloadMinutes = useCallback(async (minutes: number) => {
    await saveSetting("modelIdleUnloadMinutes", minutes);
    void invoke("set_model_idle_unload_minutes", { minutes }).catch(() => {});
  }, []);

  return {
    saveCleanupMode,
    reformatEnabled,
    reformatStyle,
    reformatLists,
    reformatContext,
    saveReformatSetting,
    trackApplicationUsage,
    saveTrackApplicationUsage,
    dictionaryEnabled,
    saveDictionaryEnabled,
    autoLearnWords,
    saveAutoLearnWords,
    observeCorrections,
    saveObserveCorrections,
    theme,
    whisperPrompt,
    saveTheme,
    saveWhisperPrompt,
    onboardingComplete,
    saveOnboardingComplete,
    transcriptionLanguage,
    saveTranscriptionLanguage,
    modelIdleUnloadMinutes,
    saveModelIdleUnloadMinutes,
    triggerKey,
    saveTriggerKey,
    settingsLoaded,
  };
}
