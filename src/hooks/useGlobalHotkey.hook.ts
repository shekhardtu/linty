import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { currentDictation, ownsDictation, isRecoveringDictation, recoverDictation, finishEmptyDictation } from "@/services/dictation-recovery.service";
import { DictationTrigger } from "@/lib/dictation-trigger";
import { useRecording } from "./useRecording.hook";
import { useTranscription } from "./useTranscription.hook";
import { useAppStore } from "@/store/app.store";
import { FALLBACK_TRIGGER_ACCELERATOR } from "@/store/slices/settings.slice";
import { isModifierHoldTrigger, triggerModifierName, formatTriggerLabel } from "@/lib/trigger.util";

export function useGlobalHotkey() {
  const { startRecording, stopRecording } = useRecording();
  const { processAudio, clearPendingTimers } = useTranscription();
  const resetRecording = useAppStore((s) => s.resetRecording);

  // Latest-ref pattern: always hold current callback references so
  // event listeners never go stale and effects don't need to re-register.
  const stopRecordingRef = useRef(stopRecording);
  const processAudioRef = useRef(processAudio);
  const startRecordingRef = useRef(startRecording);
  const clearPendingTimersRef = useRef(clearPendingTimers);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
    processAudioRef.current = processAudio;
    startRecordingRef.current = startRecording;
    clearPendingTimersRef.current = clearPendingTimers;
  }, [stopRecording, processAudio, startRecording, clearPendingTimers]);

  const isRecordingRef = useRef(false);
  const isRecording = useAppStore((s) => s.isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Synchronous lock — prevents concurrent release handling / duplicate pastes
  const processingRef = useRef(false);
  const gestureRef = useRef<DictationTrigger | null>(null);

  const showRecording = useCallback(() => {
    const state = useAppStore.getState();
    return invoke("emit_capsule_state", {
      state: "recording", handsFree: state.handsFree, generation: state.recordingGeneration,
    });
  }, []);

  const handlePress = useCallback(async () => {
    if (isRecordingRef.current || processingRef.current || isRecoveringDictation()) {
      gestureRef.current?.reset();
      return;
    }
    // Synchronously mark as recording BEFORE any async work — prevents a fast
    // fn-release from seeing isRecordingRef as false and being silently dropped.
    isRecordingRef.current = true;
    // Cancel any stale hide/reset timers from a previous recording session
    clearPendingTimersRef.current();

    const inFocus = document.hasFocus();

    try {
      // Mount the focused view before capture starts so even a very fast result
      // belongs to this visit. Keep the originating page and its state mounted.
      if (inFocus) flushSync(() => useAppStore.getState().setRecordingFocusOpen(true));
      const starting = startRecordingRef.current();
      const session = currentDictation();
      const started = await starting;
      if (!ownsDictation(session)) return;
      if (!started) { isRecordingRef.current = false; gestureRef.current?.reset(); return; }
      // A quick release may already be stopping the stream. Never overwrite its state.
      if (!inFocus && isRecordingRef.current && !processingRef.current) {
        void invoke("show_capsule").then(() => {
          if (ownsDictation(session) && !session.cancelled && isRecordingRef.current && !processingRef.current) return showRecording();
        }).catch(() => {});
        void invoke("play_capsule_sound", { sound: "start" }).catch(() => {});
      }
    } catch (error) {
      isRecordingRef.current = false;
      gestureRef.current?.reset();
      await recoverDictation(error instanceof Error ? error.message : String(error));
    }
  }, [showRecording]);

  const finishRecording = useCallback(async (discard = false) => {
    if (!isRecordingRef.current || processingRef.current) return;
    // Immediately lock to prevent any concurrent entry
    processingRef.current = true;
    isRecordingRef.current = false;
    gestureRef.current?.reset(true);

    const session = currentDictation();
    try {
      const result = await stopRecordingRef.current({ deferEmpty: discard });
      if (discard && !session.cancelled) {
        await session.run(() => invoke("recover_recording"), 5000, "Could not release the empty recording. Please try again.");
        finishEmptyDictation(session, "quiet-stop");
      } else if (result.sample_count > 0 && !session.cancelled) {
        await processAudioRef.current(result);
      }
    } catch (error) {
      if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
    } finally {
      if (ownsDictation(session)) processingRef.current = false;
    }
  }, []);

  if (!gestureRef.current) gestureRef.current = new DictationTrigger({
    start: () => { void handlePress(); },
    stop: () => { void finishRecording(); },
    latch: () => {
      useAppStore.getState().setHandsFree(true);
      if (useAppStore.getState().isRecording) void showRecording().catch(() => {});
    },
  });

  useEffect(() => () => gestureRef.current?.reset(), []);

  // Native capture owns silence timing. Generation checks reject queued events
  // from a capture that was already stopped or replaced.
  useEffect(() => {
    type QuietInput = { generation: number; quiet_seconds: number; heard_input: boolean };
    const current = (payload: { generation: number }) => {
      const state = useAppStore.getState();
      return state.isRecording && state.recordingGeneration === payload.generation;
    };
    const listeners = [
      listen<QuietInput>("recording-quiet", ({ payload }) => {
        if (!current(payload)) return;
        useAppStore.getState().setQuietSeconds(payload.quiet_seconds);
      }),
      listen<QuietInput>("recording-auto-stopped", ({ payload }) => {
        if (!current(payload)) return;
        void finishRecording(!payload.heard_input);
      }),
      listen<{ generation: number }>("capsule-stop", ({ payload }) => {
        if (payload && current(payload)) void finishRecording();
      }),
    ];
    return () => { for (const listener of listeners) void listener.then((off) => off()); };
  }, [finishRecording]);

  // ── Ensure fn key monitor is active (handles dev rebuilds losing accessibility) ──
  useEffect(() => {
    invoke("reinit_fn_key_monitor").catch(() => {});
  }, []);

  // Recover both the native capture and every frontend lock. A late result
  // from a cancelled dictation cannot paste or change the next attempt's UI.
  useEffect(() => {
    const recover = async (message: string) => {
      gestureRef.current?.reset();
      await recoverDictation(message);
      processingRef.current = false;
      isRecordingRef.current = false;
      resetRecording();
    };
    const listeners = [
      listen<string>("audio-stream-error", ({ payload }) => { void recover(payload); }),
      listen<string>("watchdog-recovery", ({ payload }) => { void recover(payload); }),
      listen("system-wake", () => {
        const state = useAppStore.getState();
        if (isRecordingRef.current || processingRef.current || state.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) {
          void recover("Dictation interrupted by sleep. Please try again.");
        }
        void invoke("force_reinit_fn_key_monitor").catch(() => {});
      }),
    ];
    return () => { for (const listener of listeners) void listener.then((off) => off()); };
  }, [resetRecording]);

  // ── Primary: modifier-hold push-to-talk (fn or a bare modifier key) ──
  // The Rust flagsChanged monitor emits fnkey-pressed/released for whichever
  // modifier bit set_trigger_modifier points it at.
  const triggerKey = useAppStore((s) => s.triggerKey);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  useEffect(() => {
    // Changing a trigger cannot orphan a held/latching recording.
    return () => {
      gestureRef.current?.reset();
      if (isRecordingRef.current) void finishRecording();
    };
  }, [triggerKey, finishRecording]);
  useEffect(() => {
    if (!settingsLoaded || !isModifierHoldTrigger(triggerKey)) return;

    invoke("set_trigger_modifier", {
      modifier: triggerModifierName(triggerKey),
    }).catch((err) => console.error("Failed to set trigger modifier:", err));

    const unlistenPress = listen("fnkey-pressed", () => gestureRef.current?.press("modifier"));
    const unlistenRelease = listen("fnkey-released", () => gestureRef.current?.release("modifier"));

    return () => {
      unlistenPress.then((fn) => fn());
      unlistenRelease.then((fn) => fn());
    };
  }, [triggerKey, settingsLoaded]);

  // ── Accelerator trigger: the configured combo, or Cmd+Shift+Space as
  //    an alternate alongside modifier-hold triggers ──
  useEffect(() => {
    if (!settingsLoaded) return;
    const accelerator = isModifierHoldTrigger(triggerKey)
      ? FALLBACK_TRIGGER_ACCELERATOR
      : triggerKey;
    let mounted = true;

    const setup = async () => {
      try {
        const alreadyRegistered = await isRegistered(accelerator);
        if (alreadyRegistered) {
          await unregister(accelerator);
        }

        await register(accelerator, async (event) => {
          if (!mounted) return;

          if (event.state === "Pressed") {
            gestureRef.current?.press("accelerator");
          } else if (event.state === "Released") {
            gestureRef.current?.release("accelerator");
          }
        });
      } catch (err) {
        console.error("Failed to register hotkey:", err);
        // Only toast for a user-chosen trigger — the silent fallback combo
        // failing shouldn't interrupt anyone.
        if (!isModifierHoldTrigger(triggerKey)) {
          useAppStore.getState().addToast({
            type: "error",
            message: `Could not register ${formatTriggerLabel(accelerator)} — another app may be using it. Pick a different trigger in Shortcuts.`,
          });
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      unregister(accelerator).catch(() => {});
    };
  }, [triggerKey, settingsLoaded]);
}
