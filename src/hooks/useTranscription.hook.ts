import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { copyTranscript } from "@/lib/transcript-clipboard.util";
import { useAppStore } from "@/store/app.store";
import { refreshHistory } from "@/services/history.service";
import { noteDictionaryUse } from "@/services/dictionary.service";
import { currentDictation, ownsDictation, finishEmptyDictation, recoverDictation } from "@/services/dictation-recovery.service";
import { transcriptionTimeoutMs } from "@/lib/dictation-session";
import type { TranscriptRecord } from "@/types/transcript.types";
import type { StopResult } from "./useRecording.hook";

interface Outcome {
  record: TranscriptRecord | null;
  warnings: string[];
  recognized: string[];
  corrected: string[];
}

/** Presentation only. The native session owns every processing side effect. */
export function useTranscription() {
  const { status, rawTranscript, correctedTranscript, finalText, error, resetTranscription } = useAppStore();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearPendingTimers = useCallback(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
  }, []);

  useEffect(() => {
    let disposed = false;
    const subscriptions = [
      listen<{ generation: number; stage: "preparing" | "transcribing" | "correcting" | "pasting" }>("dictation-stage", ({ payload }) => {
        const state = useAppStore.getState();
        if (!disposed && payload.generation === state.recordingGeneration && !currentDictation().cancelled) state.setStatus(payload.stage);
      }),
      listen("dictation-history-changed", () => { if (!disposed) void refreshHistory().catch(() => {}); }),
    ];
    return () => { disposed = true; clearPendingTimers(); subscriptions.forEach(p => void p.then(unlisten => unlisten())); };
  }, [clearPendingTimers]);

  const processAudio = useCallback(async (audio: StopResult) => {
    clearPendingTimers();
    const session = currentDictation();
    if (session.cancelled || !audio.sample_count || audio.recording_generation == null) return;
    try {
      // This waits for the already-running session; repeated reads never repeat paste.
      const outcome = await session.run(() => invoke<Outcome>("dictation_result", { generation: audio.recording_generation }),
        transcriptionTimeoutMs(audio.duration_secs) + 450_000, "Dictation did not finish. Check History before retrying.");
      if (!ownsDictation(session) || session.cancelled) return;
      const state = useAppStore.getState();
      for (const message of outcome.warnings) state.addToast({ type: "warning", message });
      await refreshHistory().catch(() => state.addToast({ type: "warning", message: "Could not refresh History. Your saved text is still available when it reloads." }));
      if (!ownsDictation(session) || session.cancelled) return;
      if (!outcome.record) { finishEmptyDictation(session); return; }
      const record = outcome.record;
      state.setRawTranscript(record.rawText);
      state.setCorrectedTranscript(record.reformattedText ?? "");
      state.setFinalText(record.finalText);
      void noteDictionaryUse({ recognized: outcome.recognized, corrected: outcome.corrected }).catch(() => {});
      state.setStatus("done");
      if (record.deliveryStatus === "failed") state.addToast({ type: "error", message: "Paste failed. Copy your text to retry.", action: { label: "Copy text", onClick: () => { void copyTranscript(record); } } });
      else if (record.deliveryStatus !== "verified") state.addToast({ type: "warning", message: "Paste could not be confirmed. Check the destination before copying again.", action: { label: "Copy text", onClick: () => { void copyTranscript(record); } } });
      if (record.deliveryStatus === "verified") void invoke("play_capsule_sound", { sound: "success" }).catch(() => {});
      timers.current.push(setTimeout(() => {
        if (ownsDictation(session) && !session.cancelled) void invoke("hide_capsule").catch(() => {});
      }, record.deliveryStatus === "verified" ? 5000 : 8000));
      timers.current.push(setTimeout(() => {
        if (ownsDictation(session) && !session.cancelled) useAppStore.getState().resetTranscription();
      }, 3000));
    } catch (error) {
      if (!ownsDictation(session) || session.cancelled) return;
      await refreshHistory().catch(() => {});
      await recoverDictation(error instanceof Error ? error.message : String(error), session);
    }
  }, [clearPendingTimers]);
  return { status, rawTranscript, correctedTranscript, finalText, error, processAudio, resetTranscription, clearPendingTimers };
}
