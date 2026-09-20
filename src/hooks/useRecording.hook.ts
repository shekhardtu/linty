import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import type { ApplicationIdentity } from "@/types/transcript.types";
import { beginDictation, currentDictation, finishEmptyDictation, isRecoveringDictation, ownsDictation, recoverDictation } from "@/services/dictation-recovery.service";
import type { DictationSession } from "@/lib/dictation-session";
import { dictationOptions } from "@/services/dictation-options.service";
import { initializeDictionary } from "@/services/dictionary.service";

export interface StopResult {
  sample_count: number;
  duration_secs: number;
  recording_generation?: number;
  application?: ApplicationIdentity | null;
}

// The hotkey and microphone-test widget control the same native recording.
let starting: { session: DictationSession; promise: Promise<boolean> } | null = null;
let startedAt = 0;

export function useRecording() {
  const isRecording = useAppStore((s) => s.isRecording);
  const recordingDuration = useAppStore((s) => s.recordingDuration);

  const startRecording = useCallback(() => {
    if (starting && ownsDictation(starting.session) && !starting.session.cancelled) return starting.promise;
    const state = useAppStore.getState();
    if (state.updateStatus === "installing" || isRecoveringDictation() || state.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) return Promise.resolve(false);
    const session = beginDictation();
    const promise = (async () => {
      try {
        await initializeDictionary();
        const settings = useAppStore.getState();
        if (!settings.settingsLoaded) throw new Error("Settings are still loading. Please try again.");
        useAppStore.getState().setStatus("preparing");
        if (!document.hasFocus()) void invoke("show_capsule").then(() => {
          if (ownsDictation(session) && !session.cancelled && useAppStore.getState().status === "preparing") {
            return invoke("emit_capsule_state", { state: "preparing" });
          }
        }).catch(() => {});
        const generation = await session.run(() => invoke<number>("start_dictation", { options: dictationOptions() }), 10_000, "Microphone did not start. Check your input and try again.");
        useAppStore.getState().setRecordingGeneration(generation);
        startedAt = Date.now();
        useAppStore.getState().setIsRecording(true);
        useAppStore.getState().setStatus("recording");
        // Capture never waits for model loading. Transcription shares this work
        // if it is still pending, or retries a failed preparation after stop.
        // The native session starts its own preparation while recording.
        return true;
      } catch (error) {
        if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
        return false;
      }
    })();
    starting = { session, promise };
    void promise.finally(() => { if (starting?.session === session) starting = null; });
    return promise;
  }, []);

  const stopRecording = useCallback(async (options?: { deferEmpty?: boolean }): Promise<StopResult> => {
    const session = currentDictation();
    const empty = { sample_count: 0, duration_secs: 0 };
    if (starting?.session === session && !(await starting.promise)) return empty;
    if (session.cancelled) return empty;
    try {
      const result = await session.run(() => invoke<StopResult>("stop_dictation", { generation: useAppStore.getState().recordingGeneration, discard: options?.deferEmpty ?? false }), 5000, "Microphone did not stop. Please try again.");
      useAppStore.getState().setIsRecording(false);
      useAppStore.getState().setHandsFree(false);
      useAppStore.getState().setQuietSeconds(0);
      if (result.sample_count > 0) useAppStore.getState().setStatus("preparing");
      else if (!options?.deferEmpty) finishEmptyDictation(session);
      return result;
    } catch (error) {
      if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
      return empty;
    }
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(() => useAppStore.getState().setRecordingDuration((Date.now() - startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [isRecording]);

  return { isRecording, recordingDuration, startRecording, stopRecording, getRecordingStartTime: () => startedAt };
}
