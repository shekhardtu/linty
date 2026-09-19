import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import { settingsSaveFeedback } from "@/lib/settings-save-feedback";
import { loadHistoryAudio } from "@/lib/history-audio";
import type { TranscriptRecord } from "@/types/transcript.types";
import type { CorrectionRecord } from "@/types/correction.types";
import type {
  DeletedTranscript,
  HistoryPageResult,
  HistoryRetention,
  HistorySnapshot,
} from "@/types/history.types";

export const HISTORY_PAGE_SIZE = 50;
let hydration: Promise<void> | undefined;
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(work);
  queue = next;
  return next;
}
async function readSnapshot() {
  const epoch = useAppStore.getState().historyCacheEpoch;
  try {
    const snapshot = await invoke<HistorySnapshot>("history_snapshot");
    if (epoch === useAppStore.getState().historyCacheEpoch) {
      useAppStore.getState().setHistorySnapshot(snapshot);
    }
  } catch (error) {
    useAppStore.getState().setHistoryError(String(error));
    throw error;
  }
}
export function initializeHistory(): Promise<void> {
  return (hydration ??= serialize(readSnapshot).catch((error) => {
    hydration = undefined;
    throw error;
  }));
}
export async function refreshHistory() {
  await initializeHistory();
  return serialize(readSnapshot);
}
export async function mutateHistory<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  await initializeHistory();
  return serialize(async () => {
    const result = await invoke<T>(command, args);
    if (["history_delete", "history_delete_audio", "history_clear", "history_set_retention"].includes(command)) {
      // Release cached text/audio even when the follow-up database read fails.
      useAppStore.getState().invalidateHistoryCache();
    }
    // A refresh failure must not report a committed write as a failed save/deletion.
    await readSnapshot().catch(() => {});
    return result;
  });
}
export async function queryHistory(query: string, offset = 0) {
  await initializeHistory();
  return invoke<HistoryPageResult>("history_query", {
    query,
    offset,
    limit: HISTORY_PAGE_SIZE,
  });
}
export async function getTranscript(id: string) {
  await initializeHistory();
  return invoke<TranscriptRecord | null>("history_get", { id });
}
export const updateTranscript = (
  id: string,
  patch: Partial<TranscriptRecord>,
) => mutateHistory<void>("history_patch", { id, patch });
export const removeTranscript = (id: string) =>
  mutateHistory<DeletedTranscript | null>("history_delete", { id });
export const restoreTranscript = (deleted: DeletedTranscript) =>
  mutateHistory<void>("history_restore", { deleted });
export async function clearHistory() {
  await mutateHistory<void>("history_clear");
  useAppStore.getState().setSelectedTranscriptId(null);
}
export const previewRetention = (days: HistoryRetention) =>
  invoke<number>("history_retention_preview", { days });
export const setHistoryRetention = (days: HistoryRetention) =>
  settingsSaveFeedback.run("historyRetention", () => mutateHistory<void>("history_set_retention", { days }));
export const exportHistory = () =>
  invoke<{ count: number; path: string } | null>("history_export");
export const setSaveAudio = (enabled: boolean) =>
  settingsSaveFeedback.run("saveAudio", () => mutateHistory<void>("history_set_save_audio", { enabled }));
export const deleteSavedAudio = (id?: string) =>
  mutateHistory<void>("history_delete_audio", { id: id ?? null });
export const getSavedAudio = (id: string, bytes: number, signal: AbortSignal) =>
  loadHistoryAudio(bytes, (offset, length) => invoke<ArrayBuffer | number[]>("history_audio", { id, offset, length }), signal);
export const exportSavedAudio = (id: string) =>
  invoke<boolean>("history_export_audio", { id });
export async function getCorrections(id: string) {
  await initializeHistory();
  return invoke<CorrectionRecord[]>("history_corrections", { id });
}
