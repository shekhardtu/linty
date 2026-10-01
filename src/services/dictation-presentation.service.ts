import { getCurrentWindow } from "@tauri-apps/api/window";

/** A hidden WebKit page can retain document focus. Use the native window. */
export async function isDictationWindowActive(): Promise<boolean> {
  try {
    const window = getCurrentWindow();
    const [focused, visible, minimized] = await Promise.all([
      window.isFocused(), window.isVisible(), window.isMinimized(),
    ]);
    return focused && visible && !minimized;
  } catch (error) {
    // Prefer visible feedback when the native focus query is unavailable.
    console.warn("Could not check dictation window focus:", error);
    return false;
  }
}
