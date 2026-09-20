import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import { initializeDictionary } from "@/services/dictionary.service";

type Readiness = "idle" | "preparing" | "ready" | "error";
let readiness: Readiness = "idle";
let revision = 0;
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<void>>();

function publish(next: Readiness) {
  readiness = next;
  for (const listener of listeners) listener();
}

export const dictationPreparation = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => readiness,
  invalidate() { revision++; publish("idle"); },
};

/** Native preparation is idempotent; check it again before transcription to cover
 * idle unloading. Only concurrent requests are shared, never stale readiness. */
function requestedPreparation() {
  const state = useAppStore.getState();
  if (!state.settingsLoaded) throw new Error("Settings are still loading. Please try again.");
  return {
    filename: state.loadedModelFilename ?? state.selectedModelFilename,
    vocabulary: state.dictionaryEnabled && state.dictionaryEntries.some((entry) => entry.enabled),
    cleanupRequired: state.reformatEnabled,
  };
}

export async function prepareDictation() {
  await initializeDictionary();
  for (;;) {
    const args = requestedPreparation();
    const key = JSON.stringify(args);
    let promise = pending.get(key);
    if (!promise) {
      const current = ++revision;
      publish("preparing");
      promise = invoke<void>("prepare_dictation", args).then(() => {
        if (current === revision && key === JSON.stringify(requestedPreparation())) publish("ready");
      }, (error) => {
        if (current === revision) publish("error");
        throw error;
      }).finally(() => { pending.delete(key); });
      pending.set(key, promise);
    }
    await promise;
    // A pending model-selection load can finish while this request waits.
    // Prepare its final selection before allowing transcription.
    if (key === JSON.stringify(requestedPreparation())) return;
  }
}

/** Installation is the user's opt-in to keeping S1 prepared. Never download
 * or enable autocorrection here. The native engine coalesces actual warm-up. */
export async function prepareInstalledCleanup() {
  const status = await invoke<{ downloaded: boolean }>("s1_model_status");
  if (status.downloaded) await invoke("prepare_s1_model");
}
