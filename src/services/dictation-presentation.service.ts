import { invoke } from "@tauri-apps/api/core";

/** Read app activation, visibility and Space together on AppKit's main thread. */
export async function isDictationWindowActive(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_dictation_window_active");
  } catch (error) {
    // Prefer visible feedback when the native focus query is unavailable.
    console.warn("Could not check dictation window focus:", error);
    return false;
  }
}
