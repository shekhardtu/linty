import { useEffect, useMemo, useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { formatTriggerLabel } from "@/lib/trigger.util";
import { TRANSCRIPTION_LANGUAGES, modelSupportsLanguage } from "@/lib/languages.util";
import { dictationPreparation } from "@/services/dictation-preparation.service";

export function useTraySync(
  saveTranscriptionLanguage: (language: string) => Promise<void>,
) {
  const status = useAppStore((s) => s.status);
  const preparation = useSyncExternalStore(dictationPreparation.subscribe, dictationPreparation.getSnapshot);
  const selectedModelFilename = useAppStore((s) => s.selectedModelFilename);
  const loadedModelFilename = useAppStore((s) => s.loadedModelFilename);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const triggerKey = useAppStore((s) => s.triggerKey);
  const transcriptionLanguage = useAppStore((s) => s.transcriptionLanguage);
  // The optional guide does not control whether dictation can be used.
  const setupComplete = settingsLoaded;
  const localReady = preparation === "ready" && modelSupportsLanguage(loadedModelFilename, transcriptionLanguage) && (!selectedModelFilename || selectedModelFilename === loadedModelFilename);
  useEffect(() => {
    const unlisten = listen<string>("audio-input-error", ({ payload }) => {
      useAppStore.getState().addToast({ type: "error", message: payload });
    });
    return () => { unlisten.then((off) => off()); };
  }, []);
  // The menu names the local engine that will actually run: the selection, else what is loaded.
  const localEngine = (selectedModelFilename ?? loadedModelFilename) === "parakeet-tdt-0.6b-v3" ? "Parakeet" : "Whisper";
  const transcripts = useAppStore((s) => s.transcripts);
  const recentTranscripts = useMemo(
    () =>
      transcripts
        .filter((transcript) => transcript.finalText.trim())
        .slice(0, 5)
        .map(({ transcriptId, finalText }) => ({ transcriptId, finalText })),
    [transcripts],
  );

  // Keep the menu in sync with new, restored, and deleted transcripts.
  useEffect(() => {
    if (!settingsLoaded) return;
    const trayStatus = ["idle", "done"].includes(status) && preparation === "preparing" ? "preparing" : status;
    const snapshot = { status: trayStatus, localEngine, recentTranscripts, localReady,
      setupComplete, triggerLabel: formatTriggerLabel(triggerKey),
      transcriptionLanguage, languages: TRANSCRIPTION_LANGUAGES };
    emit("tray-state-changed", snapshot).catch((err) => {
      console.error("Failed to update tray menu:", err);
    });
  }, [status, preparation, localEngine, settingsLoaded, recentTranscripts, localReady, setupComplete, triggerKey, transcriptionLanguage]);

  useEffect(() => {
    const unlisten = listen<string>("tray-language-changed", async ({ payload }) => {
      let error: string | null = null;
      try {
        await saveTranscriptionLanguage(payload);
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
        useAppStore.getState().addToast({ type: "error", message: error });
      }
      // Native checkmarks toggle before saving; restore the confirmed selection on failure.
      await emit("tray-language-result", { error }).catch(() => {});
    });
    return () => { void unlisten.then((off) => off()); };
  }, [saveTranscriptionLanguage]);

  useEffect(() => {
    const unlisten = listen<string>("tray-navigate", ({ payload }) => {
      const state = useAppStore.getState();
      if (payload === "settings" || payload === "history") state.setCurrentView(payload);
      // “Open Linty” keeps the user's current page and scroll position.
    });
    return () => { unlisten.then((off) => off()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<string | null>("tray-copy-result", ({ payload }) => {
      useAppStore.getState().addToast(payload
        ? { type: "error", message: payload }
        : { type: "success", message: "Copied to clipboard" });
    });
    return () => { unlisten.then((off) => off()); };
  }, []);
}
