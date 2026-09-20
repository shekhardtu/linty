import { invoke } from "@tauri-apps/api/core";

// First-run setup and Settings share downloads, including across React remounts.
const speechDownloads = new Map<string, Promise<string | null>>();
let cleanupDownload: Promise<void> | null = null;

/** Language setup and manual cleanup setup share the same native download. */
export function downloadCleanupModel() {
  if (!cleanupDownload) {
    cleanupDownload = invoke<void>("download_s1_model").finally(() => { cleanupDownload = null; });
  }
  return cleanupDownload;
}

export function downloadSpeechModel(model: { filename: string }, retry = false) {
  const existing = speechDownloads.get(model.filename);
  if (existing) return existing;
  const download = (async () => {
    if (!retry && await invoke<boolean>("check_model_exists", { filename: model.filename })) return null;
    return invoke<string>("download_model_file", {
      filename: model.filename,
    });
  })().finally(() => speechDownloads.delete(model.filename));
  speechDownloads.set(model.filename, download);
  return download;
}
