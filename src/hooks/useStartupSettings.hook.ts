import { useCallback, useEffect, useRef, useState } from "react";
import { settingsSaveFeedback } from "@/lib/settings-save-feedback";
import { getStartupSettings, setLaunchAtLogin } from "@/services/startup.service";
import type { StartupSettings } from "@/types/startup.types";

/** The displayed value comes from macOS, including changes outside Linty. */
export function useStartupSettings() {
  const [settings, setSettings] = useState<StartupSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    const request = ++revision.current;
    try {
      const snapshot = await getStartupSettings();
      if (active.current && request === revision.current) { setSettings(snapshot); setError(snapshot.error); }
    } catch {
      if (active.current && request === revision.current) setError("Could not check launch at login. Try again.");
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active.current = false; ++revision.current; window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const save = useCallback(async (enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    ++revision.current;
    setSaving(true);
    try {
      const snapshot = await settingsSaveFeedback.run("launchAtLogin", () => setLaunchAtLogin(enabled));
      if (active.current) { setSettings(snapshot); setError(snapshot.error); }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (active.current) setError(message);
      // The native operation may have succeeded while persistence failed. Always
      // re-read the real state, retaining the error so the customer can retry.
      try {
        const snapshot = await getStartupSettings();
        if (active.current) setSettings(snapshot);
      } catch { /* Keep the last confirmed state. */ }
    } finally { busy.current = false; if (active.current) setSaving(false); }
  }, []);
  return { settings, saving, error, save, refresh };
}
