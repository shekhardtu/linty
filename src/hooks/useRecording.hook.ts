import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import type { ApplicationIdentity } from "@/types/transcript.types";
import { beginDictation, currentDictation, finishEmptyDictation, isRecoveringDictation, ownsDictation, recoverDictation } from "@/services/dictation-recovery.service";
import type { DictationSession } from "@/lib/dictation-session";
import { dictationOptions } from "@/services/dictation-options.service";
import { initializeDictionary } from "@/services/dictionary.service";
import { isDictationWindowActive } from "@/services/dictation-presentation.service";

export interface StopResult {
  sample_count: number;
  duration_secs: number;
  recording_generation?: number;
  application?: ApplicationIdentity | null;
  session?: DictationSession;
}

// The hotkey and microphone-test widget control the same native recording.
let starting: { session: DictationSession; promise: Promise<boolean> } | null = null;
let stopping: { session: DictationSession; promise: Promise<StopResult> } | null = null;
// Serialize only microphone commands. A fresh trigger is accepted while the
// previous stream closes; inference and paste are never part of this chain.
let captureTail: Promise<unknown> = Promise.resolve();
let startedAt = 0;

export function isStartingRecording() {
  return !!starting && ownsDictation(starting.session) && !starting.session.cancelled && stopping?.session !== starting.session;
}

export function useRecording() {
  const isRecording = useAppStore((s) => s.isRecording);
  const recordingDuration = useAppStore((s) => s.recordingDuration);

  const startRecording = useCallback(() => {
    if (starting && isStartingRecording()) return starting.promise;
    const state = useAppStore.getState();
    if (state.updateStatus === "installing" || isRecoveringDictation() || state.isRecording) return Promise.resolve(false);
    const session = beginDictation();
    state.resetRecording();
    state.setStatus("preparing");
    const promise = captureTail.then(async () => {
      try {
        if (session.cancelled) return false;
        await initializeDictionary();
        const settings = useAppStore.getState();
        if (!settings.settingsLoaded) throw new Error("Settings are still loading. Please try again.");
        if (ownsDictation(session) && !await isDictationWindowActive()) void invoke("show_capsule").then(() => {
          if (ownsDictation(session) && !session.cancelled && useAppStore.getState().status === "preparing") {
            return invoke("emit_capsule_state", { state: "preparing" });
          }
        }).catch(() => {});
        const generation = await session.run(() => invoke<number>("start_dictation", { options: dictationOptions() }), 10_000, "Microphone did not start. Check your input and try again.");
        session.generation = generation;
        if (ownsDictation(session)) {
          useAppStore.getState().setRecordingGeneration(generation);
          if (stopping?.session !== session) {
            startedAt = Date.now();
            useAppStore.getState().setIsRecording(true);
            useAppStore.getState().setStatus("recording");
          }
        }
        // Capture never waits for model loading. Transcription shares this work
        // if it is still pending, or retries a failed preparation after stop.
        // The native session starts its own preparation while recording.
        return true;
      } catch (error) {
        if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
        return false;
      }
    });
    captureTail = promise;
    starting = { session, promise };
    void promise.finally(() => { if (starting?.session === session) starting = null; });
    return promise;
  }, []);

  const stopRecording = useCallback((options?: { deferEmpty?: boolean }): Promise<StopResult> => {
    const session = currentDictation();
    if (stopping?.session === session) return stopping.promise;
    const state = useAppStore.getState();
    state.setIsRecording(false);
    state.setHandsFree(false);
    state.setQuietSeconds(0);
    state.setStatus("preparing");
    const promise = captureTail.then(async (): Promise<StopResult> => {
      const empty = { sample_count: 0, duration_secs: 0, session };
      if (session.cancelled || session.generation == null) return empty;
      try {
        const result = await session.run(() => invoke<StopResult>("stop_dictation", { generation: session.generation, discard: options?.deferEmpty ?? false }), 5000, "Microphone did not stop. Please try again.");
        if (ownsDictation(session) && result.sample_count === 0 && !options?.deferEmpty) finishEmptyDictation(session);
        return { ...result, session };
      } catch (error) {
        if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
        return empty;
      }
    });
    captureTail = promise;
    stopping = { session, promise };
    void promise.finally(() => { if (stopping?.session === session) stopping = null; });
    return promise;
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(() => useAppStore.getState().setRecordingDuration((Date.now() - startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [isRecording]);

  return { isRecording, recordingDuration, startRecording, stopRecording, getRecordingStartTime: () => startedAt };
}
