import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store/app.store";
import { judgeCorrection } from "@/lib/correction-diff.util";
import { ingestCorrectionBatch, undoCorrectionLearning } from "@/services/dictionary.service";
import { recordCorrection } from "@/services/user-corrections.service";
import { correctionFeedback, type CorrectionFeedbackAction } from "@/lib/correction-feedback";
import type { ApplicationIdentity } from "@/types/transcript.types";
import type { CorrectionPair, CorrectionRecord } from "@/types/correction.types";

/** Payload of the Rust `correction-observed` event (src-tauri/src/corrections.rs). */
interface ObservedCorrection {
  transcriptId: string;
  wordCount: number;
  application: ApplicationIdentity;
  pairs: CorrectionPair[];
  secondsAfterPaste: number;
}

interface ObservedBatch { batchId: string; corrections: ObservedCorrection[] }

/**
 * Turns fixes the person made in the app they dictated into (seen by the
 * Accessibility watch after a paste) into corrections, exactly like an edit
 * made in History: recorded, then folded into suggestions or the dictionary.
 */
export function useCorrectionObserver() {
  useEffect(() => {
    const seen = new Set<string>();
    const unlisten = listen<ObservedBatch>("correction-observed", async ({ payload }) => {
      const { transcripts, autoLearnWords, transcriptionLanguage, observeCorrections } = useAppStore.getState();
      if (!observeCorrections || seen.has(payload.batchId)) return;
      seen.add(payload.batchId);
      if (seen.size > 100) seen.delete(seen.values().next().value!);
      const records = payload.corrections.map((correction, index): CorrectionRecord => {
        const transcript = transcripts.find((t) => t.transcriptId === correction.transcriptId);
        const record: CorrectionRecord = {
          correctionId: `${payload.batchId}-${index}`,
          transcriptId: correction.transcriptId,
          timestamp: Date.now(),
          source: "observed",
          engine: transcript?.engine ?? "local",
          modelName: transcript?.modelName ?? "",
          language: transcriptionLanguage,
          application: correction.application,
          wordCount: correction.wordCount,
          ...judgeCorrection(correction.pairs, correction.wordCount),
          pairs: correction.pairs,
        };
        return record;
      });
      try {
        for (const record of records) await recordCorrection(record);
        if (!useAppStore.getState().observeCorrections) return;
        const result = await ingestCorrectionBatch(records, autoLearnWords, payload.batchId);
        // Background feedback confirms saved learning only. Unready suggestions
        // and unavailable capture stay silent rather than asking for manual help.
        if (!result.learned) return;
        const feedback = correctionFeedback(result, useAppStore.getState().dictionaryEnabled);
        if (feedback) {
          feedback.actions = [
            { label: "Review in Dictionary", action: "review" },
            { label: "Undo learning", action: "undo", id: result.undoId },
          ];
          // A toast in the hidden main window cannot acknowledge a fix in another app.
          // The native panel queues this behind any dictation already in progress.
          await invoke("show_correction_feedback", { feedback });
        }
      } catch (error) {
        console.error("Failed to record an observed correction:", error);
      }
    });
    const action = listen<CorrectionFeedbackAction>("correction-feedback-action", async ({ payload }) => {
      try {
        if (payload.action === "undo" && payload.id) {
          await undoCorrectionLearning(payload.id);
          await invoke("show_correction_feedback", { feedback: {
            title: "Learning undone", message: "Your dictionary has been restored.", learned: false,
          } });
          return;
        }
        if (payload.action !== "review") return;
        useAppStore.getState().setCurrentView("dictionary");
        const window = getCurrentWindow();
        await window.show();
        await window.unminimize();
        await window.setFocus();
      } catch (error) {
        await invoke("show_correction_feedback", { feedback: {
          title: "Could not update Dictionary", message: error instanceof Error ? error.message : "Please try again in Dictionary.",
          learned: false, actions: [{ label: "Review in Dictionary", action: "review" }],
        } }).catch(() => {});
      }
    });
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (previous.observeCorrections && !state.observeCorrections) {
        void invoke("stop_correction_watch").catch(() => {});
      }
    });
    return () => {
      unsubscribe();
      unlisten.then((fn) => fn());
      action.then((fn) => fn());
    };
  }, []);
}
