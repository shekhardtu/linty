import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { isSupportedLanguage, modelForLanguage } from "@/lib/languages.util";
import { saveSettingsChange } from "@/lib/settings-save-feedback";
import { getSettingsStore } from "@/services/settings-store.service";
import { downloadSpeechModel } from "@/services/model-download.service";
import { dictationPreparation, prepareDictation } from "@/services/dictation-preparation.service";

export interface SpeechModel {
  filename: string;
  size_mb: number;
  backend: "whisper" | "parakeet";
}

type PreparationStatus = "idle" | "checking" | "downloading" | "loading" | "waiting" | "ready" | "error" | "unavailable";
export interface LanguagePreparation {
  language: string | null;
  status: PreparationStatus;
  model: SpeechModel | null;
  progress: number;
  error: string | null;
}

const initial: LanguagePreparation = { language: null, status: "idle", model: null, progress: 0, error: null };
let snapshot = initial;
const listeners = new Set<() => void>();
let activation: Promise<unknown> = Promise.resolve();
let request: { language: string; controller: AbortController; promise: Promise<void> } | null = null;

function publish(change: Partial<LanguagePreparation>) {
  snapshot = { ...snapshot, ...change };
  listeners.forEach((listener) => listener());
}

export const languagePreparation = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

function dictationBusy() {
  const state = useAppStore.getState();
  return state.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status);
}

/** Downloads may continue during dictation; activation waits for it to finish. */
async function waitUntilIdle(signal: AbortSignal) {
  if (!dictationBusy() || signal.aborted) return;
  publish({ status: "waiting" });
  await new Promise<void>((resolve) => {
    const finish = () => { off(); signal.removeEventListener("abort", finish); resolve(); };
    const off = useAppStore.subscribe(() => { if (!dictationBusy()) finish(); });
    signal.addEventListener("abort", finish, { once: true });
    if (!dictationBusy() || signal.aborted) finish();
  });
}

/** All entry points share downloads and serialize activation. Only the latest
 * choice can commit a language/model pair; failures preserve the active pair. */
export function prepareLanguage(language: string): Promise<void> {
  if (!isSupportedLanguage(language)) return Promise.reject(new Error("Choose a supported transcription language."));
  if (!request && snapshot.status === "ready" && snapshot.language === language && useAppStore.getState().transcriptionLanguage === language &&
    (snapshot.model?.filename === useAppStore.getState().loadedModelFilename && dictationPreparation.getSnapshot() === "ready")) return Promise.resolve();
  if (request?.language === language) return request.promise;
  request?.controller.abort();
  const controller = new AbortController();
  const current = () => !controller.signal.aborted;
  publish({ ...initial, language, status: "checking" });

  const promise = (async () => {
    let stopProgress: (() => void) | undefined;
    try {
      if (!await invoke<boolean>("is_local_stt_available")) {
        if (!current()) return;
        const message = "On-device dictation is unavailable in this build. Install a version of Linty that includes on-device speech support.";
        publish({ status: "unavailable", error: message });
        throw new Error(message);
      }
      if (!current()) return;
      const model = modelForLanguage(language, await invoke<SpeechModel[]>("get_available_models"));
      if (!current()) return;
      if (!model) throw new Error("No compatible speech support is available in this build.");
      publish({ model });
      const filename = model.filename;
      stopProgress = await listen<{ filename: string; progress: number }>("model-download-progress", ({ payload }) => {
        if (current() && payload.filename === filename) publish({ progress: Math.round(Math.max(0, Math.min(100, payload.progress))) });
      });
      if (!current()) return;
      if (!await invoke<boolean>("check_model_exists", { filename })) {
        if (!current()) return;
        publish({ status: "downloading" });
        await downloadSpeechModel(model);
      }
      if (!current()) return;

      const commit = activation.catch(() => {}).then(async () => {
        if (!current()) return;
        await waitUntilIdle(controller.signal);
        if (!current()) return;
        const previous = useAppStore.getState();
        const previousModel = previous.loadedModelFilename;
        let changedModel = false;
        try {
          if (previousModel !== model.filename) {
            publish({ status: "loading", progress: 100 });
            changedModel = true;
            await invoke("load_local_model", { filename: model.filename, language });
          } else if (dictationPreparation.getSnapshot() !== "ready") {
            // Idle unloading leaves the selected filename intact. Native
            // preparation reuses a resident model or reloads it if necessary.
            publish({ status: "loading", progress: 100 });
            await prepareDictation();
          }
          if (!current()) return;
          await waitUntilIdle(controller.signal);
          if (!current()) return;
          await saveSettingsChange("transcriptionLanguage", async () => {
            if (!current()) return;
            const store = await getSettingsStore();
            const oldLanguage = previous.transcriptionLanguage;
            const oldModel = previous.selectedModelFilename;
            const restore = async () => {
              await store.set("transcriptionLanguage", oldLanguage);
              await store.set("selectedModelFilename", oldModel);
              await store.save();
            };
            try {
              await store.set("transcriptionLanguage", language);
              await store.set("selectedModelFilename", model.filename);
              await store.save();
            } catch (error) {
              await restore().catch(() => {});
              throw error;
            }
            if (!current()) { await restore(); return; }
            // Native dictation captures these together at the start of a session.
            useAppStore.setState({
              transcriptionLanguage: language,
              selectedModelFilename: model.filename, loadedModelFilename: model.filename, isLocalModelDownloaded: true,
            });
          });
          if (current()) publish({ status: "ready", progress: 100 });
        } finally {
          // A late load or failed save must not replace the confirmed engine.
          if (changedModel && useAppStore.getState().loadedModelFilename !== model.filename && previousModel) {
            await invoke("load_local_model", { filename: previousModel, language: previous.transcriptionLanguage }).catch(() => {});
          }
        }
      });
      activation = commit;
      await commit;
    } catch (error) {
      if (current()) {
        publish({ status: snapshot.status === "unavailable" ? "unavailable" : "error", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    } finally {
      stopProgress?.();
      if (request?.controller === controller) request = null;
    }
  })();
  request = { language, controller, promise };
  return promise;
}
