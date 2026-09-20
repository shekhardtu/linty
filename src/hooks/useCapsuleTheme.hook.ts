import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { useTheme } from "@/hooks/useTheme.hook";
import type { ThemePreference } from "@/store/slices/settings.slice";

/** The overlay is a separate webview; subscribe to the shared appearance preference. */
export function useCapsuleTheme() {
  useTheme();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let changed = false;
    const connect = async () => {
      const stop = await listen<ThemePreference>("theme-changed", ({ payload }) => {
        changed = true;
        if (!disposed) useAppStore.getState().setTheme(payload);
      });
      if (disposed) { stop(); return; }
      unlisten = stop;
      const theme = await invoke<ThemePreference>("get_theme");
      if (!disposed && !changed) useAppStore.getState().setTheme(theme);
    };
    connect().catch(() => {}); // System appearance remains a usable fallback.
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
