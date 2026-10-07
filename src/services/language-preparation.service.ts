import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { isSupportedLanguage, modelForLanguage, modelSupportsLanguage } from "@/lib/languages.util";
import { saveSettingsChange } from "@/lib/settings-save-feedback";
import { getSettingsStore } from "@/services/settings-store.service";
import { downloadCleanupModel, downloadSpeechModel } from "@/services/model-download.service";
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
  resource: "speech" | "cleanup";
  applyCleanupDefault: boolean;
}

const initial: LanguagePreparation = { language: null, status: "idle", model: null, progress: 0, error: null, resource: "speech", applyCleanupDefault: false };
let snapshot = initial;
const listeners = new Set<() => void>();
let activation: Promise<unknown> = Promise.resolve();
let request: { language: string; applyCleanupDefault: boolean; controller: AbortController; promise: Promise<void> } | null = null;
let readyForDefaultModel = true;

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
  return state.isRecording || state.pendingDictations > 0 || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status);
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
export function prepareLanguage(language: string, { applyCleanupDefault = false, preferInstalledModel = false } = {}): Promise<void> {
  if (!isSupportedLanguage(language)) return Promise.reject(new Error("Choose a supported transcription language."));
  const cleanup = language === "en" && (applyCleanupDefault || useAppStore.getState().reformatEnabled);
  if (!request && (readyForDefaultModel || preferInstalledModel) && snapshot.status === "ready" && snapshot.language === language && useAppStore.getState().transcriptionLanguage === language && cleanup === useAppStore.getState().reformatEnabled &&
    (snapshot.model?.filename === useAppStore.getState().loadedModelFilename && dictationPreparation.getSnapshot() === "ready")) return Promise.resolve();
  if (request?.language === language && (!applyCleanupDefault || request.applyCleanupDefault)) return request.promise;
  request?.controller.abort();
  const controller = new AbortController();
  const current = () => !controller.signal.aborted;
  publish({ ...initial, language, applyCleanupDefault, status: "checking" });

  const promise = (async () => {
    let failedResource: LanguagePreparation["resource"] | undefined;
    try {
      if (!await invoke<boolean>("is_local_stt_available")) {
        if (!current()) return;
        const message = "On-device dictation is unavailable in this build. Install a version of Linty that includes on-device speech support.";
        publish({ status: "unavailable", error: message });
        throw new Error(message);
      }
      if (!current()) return;
      const catalog = await invoke<SpeechModel[]>("get_available_models");
      const defaultModel = modelForLanguage(language, catalog);
      // On upgrade, make an installed compatible engine ready first. A new
      // default can download in the background without blocking dictation.
      const installed = catalog.find((candidate) => candidate.filename === useAppStore.getState().selectedModelFilename);
      const useInstalled = preferInstalledModel && installed && modelSupportsLanguage(installed.filename, language)
          && await invoke<boolean>("check_model_exists", { filename: installed.filename });
      const model = installed && useInstalled ? installed : defaultModel;
      if (!current()) return;
      if (!model) throw new Error("No compatible speech support is available in this build.");
      publish({ model });
      const filename = model.filename;
      let speechDownloaded = false;
      let cleanupProgress = 0;
      let cleanupStatus: PreparationStatus = "checking";
      const showCleanupProgress = () => {
        if (current() && speechDownloaded && cleanup) {
          publish({ resource: "cleanup", status: cleanupStatus, progress: cleanupProgress });
        }
      };

      // Start both transfers on Welcome. Keep each progress listener attached
      // throughout its download so Ready can show progress already made, even
      // when cleanup has been downloading behind the speech progress display.
      const downloadSpeech = async () => {
        let stopProgress: (() => void) | undefined;
        try {
          stopProgress = await listen<{ filename: string; progress: number }>("model-download-progress", ({ payload }) => {
            if (current() && !speechDownloaded && payload.filename === filename) publish({ progress: Math.round(Math.max(0, Math.min(100, payload.progress))) });
          });
          if (!current()) return;
          if (!await invoke<boolean>("check_model_exists", { filename })) {
            if (!current()) return;
            publish({ status: "downloading" });
            await downloadSpeechModel(model);
          }
          speechDownloaded = true;
          showCleanupProgress();
        } catch (error) {
          failedResource ??= "speech";
          throw error;
        } finally {
          stopProgress?.();
        }
      };
      const downloadCleanup = async () => {
        if (!cleanup) return;
        let stopProgress: (() => void) | undefined;
        try {
          stopProgress = await listen<number>("s1-download-progress", ({ payload }) => {
            cleanupProgress = Math.round(Math.max(0, Math.min(100, payload)));
            showCleanupProgress();
          });
          if (!current()) return;
          const status = await invoke<{ downloaded: boolean; progress: number }>("s1_model_status");
          if (!current()) return;
          if (!status.downloaded) {
            cleanupStatus = "downloading";
            cleanupProgress = status.progress;
            showCleanupProgress();
            await downloadCleanupModel();
          }
          cleanupStatus = "loading";
          cleanupProgress = 100;
          showCleanupProgress();
        } catch (error) {
          failedResource ??= "cleanup";
          throw error;
        } finally {
          stopProgress?.();
        }
      };
      await Promise.all([downloadSpeech(), downloadCleanup()]);
      if (!current()) return;

      // Selecting English includes cleanup setup. Keep the confirmed language
      // and cleanup pair intact until both models and persistence are ready.
      if (cleanup) {
        await waitUntilIdle(controller.signal);
        if (!current()) return;
        publish({ status: "loading", progress: 100 });
        await invoke("prepare_s1_model");
        if (!current()) return;
      }

      const commit = activation.catch(() => {}).then(async () => {
        if (!current()) return;
        await waitUntilIdle(controller.signal);
        if (!current()) return;
        const previous = useAppStore.getState();
        const previousModel = previous.loadedModelFilename;
        let changedModel = false;
        try {
          if (previousModel !== model.filename) {
            publish({ resource: "speech", status: "loading", progress: 100 });
            changedModel = true;
            await invoke("load_local_model", { filename: model.filename, language });
          } else if (dictationPreparation.getSnapshot() !== "ready") {
            // Idle unloading leaves the selected filename intact. Native
            // preparation reuses a resident model or reloads it if necessary.
            publish({ resource: "speech", status: "loading", progress: 100 });
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
            const oldCleanup = useAppStore.getState().reformatEnabled;
            const nextCleanup = language === "en" && (applyCleanupDefault || oldCleanup);
            const restore = async () => {
              await store.set("transcriptionLanguage", oldLanguage);
              await store.set("selectedModelFilename", oldModel);
              await store.set("reformatEnabled", oldCleanup);
              await store.save();
            };
            try {
              await store.set("transcriptionLanguage", language);
              await store.set("selectedModelFilename", model.filename);
              await store.set("reformatEnabled", nextCleanup);
              await store.save();
            } catch (error) {
              await restore().catch(() => {});
              throw error;
            }
            if (!current()) { await restore(); return; }
            // Native dictation captures these together at the start of a session.
            useAppStore.setState({
              transcriptionLanguage: language,
              reformatEnabled: nextCleanup,
              selectedModelFilename: model.filename, loadedModelFilename: model.filename, isLocalModelDownloaded: true,
            });
          });
          if (current()) {
            readyForDefaultModel = model.filename === defaultModel?.filename;
            publish({ status: "ready", progress: 100 });
          }
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
        publish({ status: snapshot.status === "unavailable" ? "unavailable" : "error", resource: failedResource ?? snapshot.resource, error: error instanceof Error ? error.message : String(error) });
        // The other shared transfer may still finish or emit progress. Keep
        // that work cached, but do not let it overwrite this request's error.
        controller.abort();
        throw error;
      }
    } finally {
      if (request?.controller === controller) request = null;
    }
  })();
  request = { language, applyCleanupDefault, controller, promise };
  return promise;
}
