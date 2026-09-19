import { deliveryLabel } from "@/lib/delivery-status";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { formatDuration } from "@/lib/usage.util";
import { useDictionary } from "@/hooks/useDictionary.hook";
import { useTranscriptCorrections } from "@/hooks/useTranscriptCorrections.hook";
import { useToast } from "@/hooks/useToast.hook";
import { addDictionaryEntry } from "@/services/dictionary.service";
import { CorrectionPanel } from "@/components/shared/CorrectionPanel.component";
import type { TranscriptRecord } from "@/types/transcript.types";
import { formatProcessingTime, ProcessingBreakdown } from "./ProcessingBreakdown.component";
import { TranscriptVersions } from "./TranscriptVersions.component";

export function TranscriptInfoDialogue({ transcript, onClose, showEditHistory = false }: {
  transcript: TranscriptRecord;
  onClose: () => void;
  showEditHistory?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const editHistory = useRef<HTMLElement>(null);
  const id = useId();
  const { entries } = useDictionary();
  const { corrections, loaded, error, retry } = useTranscriptCorrections(transcript.transcriptId);
  const toast = useToast();
  const reformatted = transcript.reformatting?.enabled && transcript.reformatting.status === "applied";
  const hasAutomaticChanges = reformatted || transcript.cloudRefinementStatus === "applied" || Boolean(transcript.dictionaryApplied?.length);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  useEffect(() => {
    if (showEditHistory && loaded) {
      editHistory.current?.focus();
    }
  }, [showEditHistory, loaded]);

  const dismiss = () => {
    // Close while the dialog is still mounted so native focus restoration
    // completes before React removes it from the document.
    dialog.current?.close();
    onClose();
  };

  const addPairToDictionary = (right: string, wrong: string) => {
    addDictionaryEntry(right, [wrong], "learned")
      .then(() => toast.success(`“${right}” added to your dictionary`))
      .catch(() => toast.error("Could not update the dictionary. Please try again."));
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="confirmation-dialog transcript-info-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-context`}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), summary",
          )).filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
    >
      <header className="transcript-info-heading">
        <h2 id={`${id}-title`}>Dictation details</h2>
        <button ref={close} type="button" className="icon-button" aria-label="Close dictation details" onClick={dismiss}>
          <X size={16} />
        </button>
      </header>
      <div className="transcript-info-content">
      <p id={`${id}-context`} className="transcript-info-context">
        {transcript.application?.name && <>{transcript.application.name} · </>}
        <time dateTime={new Date(transcript.timestamp).toISOString()}>
          {new Date(transcript.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </p>
      <dl className="transcript-info-facts">
        <div><dt>Speech engine</dt><dd>{transcript.engine === "cloud" ? "Cloud" : "On-device"}</dd></div>
        <div><dt>Model</dt><dd>{transcript.modelName}</dd></div>
        <div><dt>Audio length</dt><dd>{formatDuration(transcript.durationSeconds)}</dd></div>
        <div><dt>Words</dt><dd>{transcript.wordCount.toLocaleString()}</dd></div>
        <div><dt>Delivery</dt><dd>{deliveryLabel(transcript.deliveryStatus)}</dd></div>
        {transcript.textValidation?.status === "fallback" && <div><dt>Text preservation</dt><dd>Original kept — cleanup changed protected details</dd></div>}
        <div><dt>Total processing</dt><dd>{formatProcessingTime(transcript.processingTimeMs)}</dd></div>
      </dl>
      <ProcessingBreakdown transcript={transcript} />
      <TranscriptVersions transcript={transcript} />
      {hasAutomaticChanges && <details className="original-transcript">
        <summary>Automatic changes <ChevronDown size={14} /></summary>
        {reformatted && <p className="reading-note"><strong>S1-mini:</strong> Automatically reformatted this transcription.</p>}
        {transcript.cloudRefinementStatus === "applied" && <p className="reading-note"><strong>Cloud refinement:</strong> Automatically refined this transcription.</p>}
        {transcript.dictionaryApplied?.length ? <p className="dictionary-applied-note">
          Dictionary applied before paste:{" "}
          {transcript.dictionaryApplied.map((pair) => `${pair.from} → ${pair.to}`).join(", ")}
        </p> : null}
      </details>}
      {(!loaded || error || corrections.length > 0) && <details className="original-transcript transcript-edit-history" open={showEditHistory}>
        <summary ref={editHistory}>Edit history <ChevronDown size={14} /></summary>
        {!loaded && <p role="status">Loading edits…</p>}
        {error && <p role="alert">Could not load your edits.{" "}<button type="button" className="text-link" onClick={retry}>Retry</button></p>}
        <CorrectionPanel corrections={corrections} entries={entries} onAddToDictionary={addPairToDictionary} />
      </details>}
      </div>
    </dialog>,
    document.body,
  );
}
