import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { useAppStore } from "@/store/app.store";
import { prepareInstalledCleanup } from "@/services/dictation-preparation.service";
import { AUTO_LANGUAGE, DEFAULT_TRANSCRIPTION_LANGUAGE, isSupportedLanguage } from "@/lib/languages.util";
import { DEFAULT_MODEL_IDLE_UNLOAD_MINUTES, DEFAULT_TRIGGER_KEY } from "@/store/slices/settings.slice";
import type { SettingsSlice, SttMode, ThemePreference } from "@/store/slices/settings.slice";
import type { CleanupMode, ReformatContext, ReformatStyle } from "@/types/reformat.types";

import { saveSettingsChange } from "@/lib/settings-save-feedback";
import { DEFAULT_TYPING_SPEED, typingSpeed, validTypingSpeed } from "@/lib/payoff.util";

const STORE_PATH = "linty-settings.json";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load(STORE_PATH, {
      defaults: {
        sttMode: "local",
        correctionEnabled: true,
        reformatEnabled: false,
        reformatStyle: "semi-formal",
        reformatLists: true,
        reformatContext: "auto",
        theme: "system",
        whisperPrompt: "",
        correctionPrompt: "",
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

export { getStore as getSettingsStore };

/** Persist first, and only report success once the write reaches disk. */
export function saveSetting<K extends keyof SettingsSlice>(key: K, value: SettingsSlice[K]) {
  return saveSettingsChange(key, async () => {
    const store = await getStore();
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

export async function saveTypingSpeed(speed: number) {
  if (!validTypingSpeed(speed)) throw new Error("Enter a valid typing speed in words per minute.");
  await saveSetting("typingWordsPerMinute", speed);
}

export function useSettings() {
  const {
    groqApiKey,
    sttMode,
    correctionEnabled,
    reformatEnabled,
    reformatStyle,
    reformatLists,
    reformatContext,
    theme,
    whisperPrompt,
    correctionPrompt,
    onboardingComplete,
    transcriptionLanguage,
    setGroqApiKey,
    setSttMode,
    setCorrectionEnabled,
    setTheme,
    setWhisperPrompt,
    setCorrectionPrompt,
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
        const key = await invoke<string>("get_groq_api_key").catch((error) => {
          useAppStore.getState().addToast({ type: "error", message: String(error) });
          return "";
        });
        const mode = await store.get<SttMode>("sttMode");
        const correction = await store.get<boolean>("correctionEnabled");
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
        const savedCorrectionPrompt = await store.get<string>("correctionPrompt");
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

        setGroqApiKey(key);
        if (mode) setSttMode(mode);
        if (correction !== null && correction !== undefined)
          setCorrectionEnabled(correction);
        if (savedTheme) setTheme(savedTheme);
        if (savedWhisperPrompt) setWhisperPrompt(savedWhisperPrompt);
        if (savedCorrectionPrompt) setCorrectionPrompt(savedCorrectionPrompt);
        if (savedOnboarding) setOnboardingComplete(savedOnboarding);
        // Fresh setup defaults to English. Preserve a saved choice (including
        // auto-detect) and the former default for existing users without a key.
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
  }, [setGroqApiKey, setSttMode, setCorrectionEnabled, setTheme, setWhisperPrompt, setCorrectionPrompt, setOnboardingComplete, setTranscriptionLanguage, setSelectedModelFilename, setModelIdleUnloadMinutes, setTriggerKey, setSettingsLoaded, setTrackApplicationUsage, setDictionaryEnabled, setAutoLearnWords, setObserveCorrections]);

  const saveGroqApiKey = useCallback((key: string) => saveSettingsChange("groqApiKey", async () => {
    const trimmed = key.trim();
    await invoke("set_groq_api_key", { key: trimmed });
    setGroqApiKey(trimmed);
  }), [setGroqApiKey]);

  const removeGroqApiKey = useCallback(() => saveSettingsChange("groqApiKey", async () => {
    const state = useAppStore.getState();
    if (state.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status)) {
      throw new Error("Finish dictating before removing your API key.");
    }
    await invoke("remove_groq_api_key");
    useAppStore.setState({ groqApiKey: "", sttMode: "local" });
  }), []);

  const saveTrackApplicationUsage = useCallback((enabled: boolean) => saveSetting("trackApplicationUsage", enabled), []);
  const saveDictionaryEnabled = useCallback((enabled: boolean) => saveSetting("dictionaryEnabled", enabled), []);
  const saveAutoLearnWords = useCallback((enabled: boolean) => saveSetting("autoLearnWords", enabled), []);
  const saveObserveCorrections = useCallback((enabled: boolean) => saveSetting("observeCorrections", enabled), []);

  const saveSttMode = useCallback(async (mode: SttMode) => {
    if (mode === "cloud" && !useAppStore.getState().groqApiKey.trim()) {
      throw new Error("Add a Groq API key in Settings → Speech engine first.");
    }
    await saveSetting("sttMode", mode);
  }, []);

  const saveCorrectionEnabled = useCallback((enabled: boolean) => saveSetting("correctionEnabled", enabled), []);

  const saveCleanupMode = useCallback((mode: CleanupMode) => saveSettingsChange("cleanupMode", async () => {
    const state = useAppStore.getState();
    if (state.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) {
      throw new Error("Finish dictating before changing text cleanup.");
    }
    if (mode === "cloud" && (state.sttMode !== "cloud" || !state.groqApiKey.trim())) {
      throw new Error("Set up the cloud speech engine before using cloud cleanup.");
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
    const previous = { reformatEnabled: state.reformatEnabled, correctionEnabled: state.correctionEnabled };
    const next = { reformatEnabled: mode === "local", correctionEnabled: mode === "cloud" };
    try {
      await store.set("reformatEnabled", next.reformatEnabled);
      await store.set("correctionEnabled", next.correctionEnabled);
      await store.save();
    } catch (error) {
      await store.set("reformatEnabled", previous.reformatEnabled).catch(() => {});
      await store.set("correctionEnabled", previous.correctionEnabled).catch(() => {});
      throw error;
    }
    useAppStore.setState(next);
    // Installed S1 stays prepared even when cleanup is off. The shared idle
    // policy releases it later; switching modes must not make it cold again.
  }), []);

  const saveReformatSetting = useCallback(<K extends "reformatStyle" | "reformatLists" | "reformatContext",>(key: K, value: SettingsSlice[K]) => saveSetting(key, value), []);
  const saveTheme = useCallback((value: ThemePreference) => saveSetting("theme", value), []);
  const saveWhisperPrompt = useCallback((value: string) => saveSetting("whisperPrompt", value), []);
  const saveCorrectionPrompt = useCallback((value: string) => saveSetting("correctionPrompt", value), []);
  const saveOnboardingComplete = useCallback((value: boolean) => saveSetting("onboardingComplete", value), []);
  const saveTranscriptionLanguage = useCallback(async (value: string) => {
    const state = useAppStore.getState();
    if (state.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status)) {
      throw new Error("Finish dictating before changing the transcription language.");
    }
    if (!isSupportedLanguage(value)) throw new Error("Choose a supported transcription language.");
    await saveSetting("transcriptionLanguage", value);
  }, []);
  const saveSelectedModelFilename = useCallback((value: string | null) => saveSetting("selectedModelFilename", value), []);
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
    groqApiKey,
    sttMode,
    correctionEnabled,
    theme,
    whisperPrompt,
    correctionPrompt,
    saveGroqApiKey,
    removeGroqApiKey,
    saveSttMode,
    saveCorrectionEnabled,
    saveTheme,
    saveWhisperPrompt,
    saveCorrectionPrompt,
    onboardingComplete,
    saveOnboardingComplete,
    transcriptionLanguage,
    saveTranscriptionLanguage,
    saveSelectedModelFilename,
    modelIdleUnloadMinutes,
    saveModelIdleUnloadMinutes,
    triggerKey,
    saveTriggerKey,
    settingsLoaded,
  };
}
