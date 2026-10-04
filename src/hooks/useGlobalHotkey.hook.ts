import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { isDictationWindowActive } from "@/services/dictation-presentation.service";
import { currentDictation, ownsDictation, isRecoveringDictation, recoverDictation, finishEmptyDictation } from "@/services/dictation-recovery.service";
import type { DictationSession } from "@/lib/dictation-session";
import { DictationTrigger } from "@/lib/dictation-trigger";
import { isStartingRecording, useRecording } from "./useRecording.hook";
import { useTranscription } from "./useTranscription.hook";
import { useAppStore } from "@/store/app.store";
import { FALLBACK_TRIGGER_ACCELERATOR } from "@/store/slices/settings.slice";
import { isModifierHoldTrigger, triggerModifierName, formatTriggerLabel } from "@/lib/trigger.util";

export function useGlobalHotkey(enabled = true) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
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
    if (!isStartingRecording()) isRecordingRef.current = isRecording;
  }, [isRecording]);

  const stoppingSessionRef = useRef<DictationSession | null>(null);
  const gestureRef = useRef<DictationTrigger | null>(null);

  const showRecording = useCallback(() => {
    const state = useAppStore.getState();
    return invoke("emit_capsule_state", {
      state: "recording", handsFree: state.handsFree, generation: state.recordingGeneration,
    });
  }, []);

  const handlePress = useCallback(async () => {
    if (!enabledRef.current || isRecordingRef.current || isRecoveringDictation()) {
      gestureRef.current?.reset();
      return;
    }
    // Synchronously mark as recording BEFORE any async work — prevents a fast
    // fn-release from seeing isRecordingRef as false and being silently dropped.
    isRecordingRef.current = true;
    // Cancel any stale hide/reset timers from a previous recording session
    clearPendingTimersRef.current();

    let session: DictationSession | undefined;
    try {
      const focus = isDictationWindowActive();
      // Reserve startup before awaiting focus: a fast release must still wait
      // for this microphone and close it rather than start a second capture.
      const starting = startRecordingRef.current();
      session = currentDictation();
      const owner = session;
      const inFocus = await focus;
      if (!ownsDictation(session) || session.cancelled) return;
      if (inFocus) flushSync(() => useAppStore.getState().setRecordingFocusOpen(true));
      const started = await starting;
      if (!ownsDictation(session)) return;
      if (!started) { isRecordingRef.current = false; gestureRef.current?.reset(); return; }
      // A quick release may already be stopping the stream. Never overwrite its state.
      if (!await isDictationWindowActive() && isRecordingRef.current && stoppingSessionRef.current !== session) {
        void invoke("show_capsule").then(() => {
          if (ownsDictation(owner) && !owner.cancelled && isRecordingRef.current && stoppingSessionRef.current !== owner) return showRecording();
        }).catch(() => {});
        void invoke("play_capsule_sound", { sound: "start" }).catch(() => {});
      }
    } catch (error) {
      if (session && !ownsDictation(session)) return;
      isRecordingRef.current = false;
      gestureRef.current?.reset();
      await recoverDictation(error instanceof Error ? error.message : String(error), session);
    }
  }, [showRecording]);

  // Dictation can outlive a focus change. Move its presentation between the
  // main dialog and the pill without restarting capture or processing.
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const listener = getCurrentWindow().onFocusChanged(async () => {
      const request = ++revision;
      const focused = await isDictationWindowActive();
      if (disposed || request !== revision) return;
      const state = useAppStore.getState();
      if (!["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status)) return;
      if (focused) {
        state.setRecordingFocusOpen(true);
        void invoke("hide_capsule").catch(() => {});
      } else {
        const session = currentDictation();
        void invoke("show_capsule").then(() => {
          if (disposed || request !== revision || !ownsDictation(session) || session.cancelled) return;
          const latest = useAppStore.getState();
          if (["preparing", "recording", "transcribing", "correcting", "pasting"].includes(latest.status)) {
            return invoke("emit_capsule_state", {
              state: latest.status, handsFree: latest.handsFree, generation: latest.recordingGeneration,
            });
          }
        }).catch(() => {});
      }
    });
    return () => { disposed = true; void listener.then(unlisten => unlisten()); };
  }, []);

  const finishRecording = useCallback(async (discard = false) => {
    if (!isRecordingRef.current) return;
    const session = currentDictation();
    stoppingSessionRef.current = session;
    isRecordingRef.current = false;
    gestureRef.current?.reset(true);

    let audio: Awaited<ReturnType<typeof stopRecording>> | undefined;
    try {
      const result = await stopRecordingRef.current({ deferEmpty: discard });
      if (discard && !session.cancelled) {
        // Native stop already releases this capture. Global recovery would
        // cancel earlier dictations still being delivered in the background.
        finishEmptyDictation(session, "quiet-stop");
      } else if (result.sample_count > 0 && !session.cancelled) {
        audio = result;
      }
    } catch (error) {
      if (!session.cancelled) await recoverDictation(error instanceof Error ? error.message : String(error), session);
    } finally {
      if (stoppingSessionRef.current === session) stoppingSessionRef.current = null;
    }
    if (audio) await processAudioRef.current(audio, session);
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
      stoppingSessionRef.current = null;
      isRecordingRef.current = false;
      resetRecording();
    };
    const listeners = [
      listen<string>("audio-stream-error", ({ payload }) => { void recover(payload); }),
      listen<string>("watchdog-recovery", ({ payload }) => { void recover(payload); }),
      listen("system-wake", () => {
        const state = useAppStore.getState();
        if (isRecordingRef.current || stoppingSessionRef.current || state.isRecording || state.pendingDictations > 0 || ["preparing", "transcribing", "correcting", "pasting"].includes(state.status)) {
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
