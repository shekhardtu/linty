import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { INPUT_LEVEL_INTERVAL_MS } from "@/lib/dictation-waveform";

/**
 * Poll the microphone level while `active`. The level is read over Tauri's
 * request channel rather than pushed as events: every pushed event is a script
 * evaluation that WebKit caches per unique payload, which grew the capsule's
 * web process with each frame (#150). One request is in flight at a time.
 */
export function useInputLevel(active: boolean, onLevel: (rms: number) => void) {
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    const tick = async () => {
      if (pending) return;
      pending = true;
      try {
        const rms = await invoke<number>("input_level");
        if (!disposed) onLevelRef.current(rms);
      } catch {
        // A failed read skips one frame; the next tick retries.
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, INPUT_LEVEL_INTERVAL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [active]);
}
