import { useId, useLayoutEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { saveTypingSpeed } from "@/hooks/useSettings.hook";
import {
  DEFAULT_TYPING_SPEED,
  estimatePayoff,
  formatEstimatedTime,
  MAX_TYPING_SPEED,
  MIN_TYPING_SPEED,
  paceChange,
  validTypingSpeed,
} from "@/lib/payoff.util";
import { formatDuration } from "@/lib/usage.util";
import type { UsageSummary } from "@/types/history.types";
import { Metric } from "@/components/shared/Metric.component";

export function PayoffSummary({
  summary,
  comparison,
  comparisonDays,
}: {
  summary: UsageSummary;
  comparison: UsageSummary | null;
  comparisonDays: number | null;
}) {
  const baseline = useAppStore((s) => s.typingWordsPerMinute);
  const estimate = estimatePayoff(summary.timing, baseline);
  const speedRatio = estimate?.speedRatio.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
  const speedComparison = estimate
    ? `About ${speedRatio}× your typing baseline, including processing.`
    : null;
  const [open, setOpen] = useState(false);
  const info = useRef<HTMLButtonElement>(null);
  const positive = estimate && estimate.savedSeconds >= 30;
  const similar = estimate && Math.abs(estimate.savedSeconds) < 30;
  const label =
    !estimate || positive
      ? "Estimated time saved"
      : similar
        ? "Similar estimated time"
        : "Longer than typing estimate";
  const change = paceChange(summary.timing, comparison?.timing ?? null);
  const paceDetail =
    change === null
      ? "Based on recorded speech"
      : change === 0
        ? `Same pace as previous ${comparisonDays} days`
        : `${change > 0 ? "+" : "−"}${Math.abs(change)}% vs previous ${comparisonDays} days`;
  return (
    <section
      className="editorial-metrics payoff-summary"
      aria-label="Dictation summary"
    >
      <div className="payoff-label">
        <span>{label}</span>
        {estimate && (
          <span className="payoff-ratio" title={speedComparison ?? undefined}>
            {speedRatio}×
          </span>
        )}
        <button
          ref={info}
          className="icon-button payoff-info"
          aria-label="How time saved is estimated"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tooltip={`Compared with typing at ${baseline} wpm\n${speedComparison ? `${speedComparison}\n` : ""}Click to view the calculation and adjust.`}
          onClick={() => setOpen(true)}
        >
          <Info size={14} />
        </button>
      </div>
      <div className="metric-value payoff-value">
        {estimate
          ? similar
            ? "~0m"
            : `~${formatEstimatedTime(estimate.savedSeconds)}`
          : "—"}
      </div>
      <p className="payoff-caption">
        {!estimate
          ? summary.stats.sessions
            ? "Complete timing is needed to estimate your savings."
            : "Your first dictation starts here."
          : positive
            ? "Time for whatever comes next."
            : similar
              ? "Both methods take about the same time."
              : "Your typing baseline is quicker for this period."}
      </p>
      <div className="editorial-supporting-metrics">
        <Metric
          label="Words transcribed"
          value={summary.stats.words.toLocaleString()}
          detail="Thoughts put into words"
        />
        <Metric
          label="Your dictation pace"
          value={
            estimate
              ? `${Math.round(estimate.wordsPerMinute).toLocaleString()} wpm`
              : "—"
          }
          detail={paceDetail}
        />
      </div>
      <EstimateDetails
        open={open}
        summary={summary}
        baseline={baseline}
        onClose={() => {
          setOpen(false);
          requestAnimationFrame(() => info.current?.focus({ preventScroll: true }));
        }}
      />
    </section>
  );
}

function EstimateDetails({
  open,
  summary,
  baseline,
  onClose,
}: {
  open: boolean;
  summary: UsageSummary;
  baseline: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const initialBaseline = useRef(baseline);
  initialBaseline.current = baseline;
  const [draft, setDraft] = useState(String(baseline));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speed = Number(draft),
    valid = validTypingSpeed(speed);
  const estimate = valid ? estimatePayoff(summary.timing, speed) : null;
  useLayoutEffect(() => {
    if (!open) return;
    // Reset before the dialog becomes interactive, and only when opening.
    // Saved-value changes must not replace a draft or interrupt a retry.
    setDraft(String(initialBaseline.current));
    setError(null);
    setBusy(false);
    const dialog = ref.current;
    dialog?.showModal();
    field.current?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, [open]);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveTypingSpeed(speed);
      onClose();
    } catch {
      setError("Could not save your typing speed. Please try again.");
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="confirmation-dialog estimate-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const fields = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled)",
          ),
        );
        const index = fields.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        fields[
          (index + (e.shiftKey ? -1 : 1) + fields.length) % fields.length
        ]?.focus();
      }}
    >
      <div className="estimate-heading">
        <h2 id={`${id}-title`}>How this is estimated</h2>
        <button
          className="icon-button"
          aria-label="Close estimate details"
          data-tooltip="Close estimate details"
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <p id={`${id}-description`}>
        Compare dictation with the time you would spend typing the same words.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="estimate-speed">
          <label htmlFor={`${id}-speed`}>
            Typing speed for estimate<span>Words per minute</span>
          </label>
          <input
            ref={field}
            className="native-input"
            id={`${id}-speed`}
            type="number"
            inputMode="numeric"
            min={MIN_TYPING_SPEED}
            max={MAX_TYPING_SPEED}
            step={1}
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            aria-describedby={`${id}-assumption`}
          />
        </div>
        <p id={`${id}-assumption`} className="estimate-fine">
          {DEFAULT_TYPING_SPEED} wpm is a starting assumption. Set your own pace.
        </p>
        <dl className="estimate-breakdown">
          <div>
            <dt>Typing estimate</dt>
            <dd>
              {estimate ? formatEstimatedTime(estimate.typingSeconds) : "—"}
            </dd>
          </div>
          <div>
            <dt>Time dictating</dt>
            <dd>
              {summary.timing.sessions
                ? formatDuration(summary.timing.seconds)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Processing time</dt>
            <dd>
              {summary.timing.sessions
                ? formatDuration(summary.timing.processingSeconds)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>
              {estimate && estimate.savedSeconds < -30
                ? "Estimated additional time"
                : "Estimated time saved"}
            </dt>
            <dd>
              {estimate
                ? Math.abs(estimate.savedSeconds) < 30
                  ? "~0m"
                  : `~${formatEstimatedTime(estimate.savedSeconds)}`
                : "—"}
            </dd>
          </div>
        </dl>
        <p className="estimate-fine">
          Excludes editing afterward; Linty does not measure that time.
          {summary.timing.missingSessions > 0 &&
            ` Based on ${summary.timing.sessions.toLocaleString()} of ${summary.stats.sessions.toLocaleString()} dictations with complete timing.`}
        </p>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="standard-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="standard-button"
            type="submit"
            disabled={busy || !valid}
          >
            <span className="button-label-stack">
              <span aria-hidden={busy}>Save typing speed</span>
              <span aria-hidden={!busy}>Saving…</span>
            </span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
