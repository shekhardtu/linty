import { useCapsuleTheme } from "@/hooks/useCapsuleTheme.hook";
import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { listen, emit, emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LockKeyhole, Square, X, CircleAlert, BookOpen, Undo2 } from "lucide-react";
import { advanceWaveform, flatWaveform, WAVEFORM_BAR_COUNT } from "@/lib/dictation-waveform";
import type { CorrectionFeedback } from "@/lib/correction-feedback";
import lintyFavicon from "../../src-tauri/icons/icon.svg?raw";

type CapsuleMode = "idle" | "preparing" | "recording" | "transcribing" | "correcting" | "pasting" | "done" | "quiet-stop" | "error" | "feedback";
interface CapsuleStatePayload {
  state: CapsuleMode;
  error?: string;
  hands_free?: boolean;
  generation?: number;
}
interface QuietInput { generation: number; quiet_seconds: number }
const FEEDBACK_DURATION_MS = 3000;

function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function StopCountdown({ seconds }: { seconds: number }) {
  // One continuous sweep per warning, even as native events update the numeral.
  // A resumed recording unmounts this, so the next warning gets a fresh clock.
  const initialSeconds = useRef(seconds).current;
  return <span className="capsule-stop-countdown" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <circle className="capsule-countdown-track" cx="12" cy="12" r="10.5" />
      <circle
        className="capsule-countdown-ring"
        cx="12" cy="12" r="10.5"
        pathLength="100" strokeDasharray="100" strokeLinecap="round"
        strokeDashoffset={100 - seconds * 10}
        transform="rotate(-90 12 12)"
        style={{ "--countdown-start": 100 - initialSeconds * 10, animationDuration: `${initialSeconds}s` } as CSSProperties}
      />
    </svg>
    <span className="capsule-countdown-number"><span className="capsule-countdown-label">{seconds}<span className="capsule-countdown-unit">s</span></span></span>
  </span>;
}

export function CapsulePanel() {
  useCapsuleTheme();
  const [mode, setMode] = useState<CapsuleMode>("idle");
  // Keep the outgoing row mounted while it fades inside the contracting shell.
  const [expandedMode, setExpandedMode] = useState<CapsuleMode>("recording");
  const [errorMsg, setErrorMsg] = useState("");
  const [levels, setLevels] = useState(flatWaveform);
  const [duration, setDuration] = useState(0);
  const [handsFree, setHandsFree] = useState(false);
  const [quietSeconds, setQuietSeconds] = useState(0);
  const [dismissing, setDismissing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [feedback, setFeedback] = useState<CorrectionFeedback | null>(null);
  const feedbackRef = useRef<CorrectionFeedback | null>(null);
  const pendingFeedbackRef = useRef<CorrectionFeedback[]>([]);
  const presentFeedbackRef = useRef<(feedback: CorrectionFeedback) => void>(() => {});
  const modeRef = useRef<CapsuleMode>("idle");
  const generationRef = useRef<number | undefined>(undefined);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedbackRemainingRef = useRef(FEEDBACK_DURATION_MS);
  const feedbackDeadlineRef = useRef<number | null>(null);
  const feedbackInteractionRef = useRef({ pointer: false, focus: false });

  const dismiss = useCallback(() => {
    if (exitTimerRef.current !== null) return;
    if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    feedbackDeadlineRef.current = null;
    setDismissing(true);
    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      const next = pendingFeedbackRef.current.shift();
      if (next) { presentFeedbackRef.current(next); return; }
      const wasFeedback = modeRef.current === "feedback";
      feedbackRef.current = null;
      feedbackInteractionRef.current = { pointer: false, focus: false };
      modeRef.current = "idle";
      setMode("idle");
      setDismissing(false);
      invoke("hide_capsule", { feedback: wasFeedback }).catch(() => {});
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  }, []);

  const scheduleFeedbackDismissal = useCallback(() => {
    if (modeRef.current !== "feedback" || exitTimerRef.current !== null) return;
    if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    feedbackDeadlineRef.current = null;
    if (feedbackInteractionRef.current.pointer || feedbackInteractionRef.current.focus) return;
    feedbackDeadlineRef.current = Date.now() + feedbackRemainingRef.current;
    dismissTimerRef.current = setTimeout(dismiss, feedbackRemainingRef.current);
  }, [dismiss]);

  const interactWithFeedback = useCallback((kind: "pointer" | "focus", active: boolean) => {
    if (feedbackInteractionRef.current[kind] === active) return;
    feedbackInteractionRef.current[kind] = active;
    if (modeRef.current !== "feedback") return;
    if (feedbackDeadlineRef.current !== null) {
      feedbackRemainingRef.current = Math.max(0, feedbackDeadlineRef.current - Date.now());
    }
    scheduleFeedbackDismissal();
  }, [scheduleFeedbackDismissal]);

  useEffect(() => {
    const presentFeedback = (notice: CorrectionFeedback) => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
      feedbackRef.current = notice;
      modeRef.current = "feedback";
      setFeedback(notice);
      setMode("feedback");
      setExpandedMode("feedback");
      setDismissing(false);
      void invoke("show_capsule", { feedback: true }).catch(() => {});
      feedbackRemainingRef.current = FEEDBACK_DURATION_MS;
      scheduleFeedbackDismissal();
    };
    presentFeedbackRef.current = presentFeedback;
    const listeners = [
      listen<CorrectionFeedback>("correction-feedback", ({ payload }) => {
        if (modeRef.current === "idle") presentFeedback(payload);
        else pendingFeedbackRef.current.push(payload);
      }),
      listen<CapsuleStatePayload>("capsule-state", ({ payload }) => {
        const { state, error, hands_free, generation } = payload;
        // Late cleanup cannot dismiss a fresh acknowledgment. Once shown, an
        // interrupted notice is finished; it never returns after dictation.
        if (modeRef.current === "feedback") {
          if (state === "idle") return;
          feedbackRef.current = null;
          feedbackDeadlineRef.current = null;
          feedbackInteractionRef.current.focus = false;
        }
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        if (state === "idle") { dismiss(); return; }
        if (exitTimerRef.current !== null) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        const newRecording = state === "recording" && (modeRef.current !== "recording" || generationRef.current !== generation);
        modeRef.current = state;
        setMode(state);
        if (state === "recording" || state === "preparing" || state === "error" || state === "quiet-stop") setExpandedMode(state);
        setDismissing(false);
        if (state === "error") setErrorMsg(error || "Something went wrong");
        if (newRecording) {
          generationRef.current = generation;
          setDuration(0);
          setLevels(flatWaveform());
          setQuietSeconds(0);
          setStopping(false);
          const started = Date.now();
          if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = setInterval(() => setDuration((Date.now() - started) / 1000), 1000);
        }
        if (state === "recording") setHandsFree(!!hands_free);
        else if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }
        if (state === "done" || state === "quiet-stop") dismissTimerRef.current = setTimeout(dismiss, state === "done" ? 1100 : 2200);
        if (state === "error") dismissTimerRef.current = setTimeout(dismiss, 6000);
      }),
      listen<number>("capsule-amplitude", ({ payload }) => {
        if (modeRef.current !== "recording") return;
        setLevels(previous => advanceWaveform(previous, payload));
      }),
      listen<QuietInput>("recording-quiet", ({ payload }) => {
        if (modeRef.current === "recording" && payload.generation === generationRef.current) setQuietSeconds(payload.quiet_seconds);
      }),
    ];
    return () => {
      for (const listener of listeners) void listener.then(off => off());
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, [dismiss, scheduleFeedbackDismissal]);

  const isRecording = mode === "recording";
  const isDraggable = isRecording && handsFree;
  const isProcessing = ["preparing", "transcribing", "correcting", "pasting"].includes(mode);
  const isCompact = (isProcessing && mode !== "preparing") || mode === "done";
  const isQuiet = isRecording && quietSeconds >= 20;
  const expandedQuiet = expandedMode === "recording" && quietSeconds >= 20;
  const isSpeaking = isRecording && !isQuiet && levels.slice(-3).some(level => level > 0.02);
  // The three favicon strokes retain their staggered, centered movement, but
  // every height now comes from recent microphone input instead of a timed loop.
  const brandLevels = isRecording && !isQuiet
    ? [levels[WAVEFORM_BAR_COUNT - 3], levels[WAVEFORM_BAR_COUNT - 1], levels[WAVEFORM_BAR_COUNT - 2]] : [0, 0, 0];
  const remainingSeconds = Math.max(0, Math.min(10, 30 - quietSeconds));
  const announcement = mode === "idle" ? "" : isQuiet ? "Stopping automatically. Speak to keep listening, or click the countdown to finish now."
    : isRecording ? handsFree ? "Hands-free listening. Press your trigger once to finish." : "Listening. Release your trigger to finish."
    : mode === "feedback" && feedback ? `${feedback.title}. ${feedback.message}`
    : mode === "error" ? errorMsg : mode === "done" ? "Dictation complete" : mode === "quiet-stop" ? "No input. Listening stopped."
    : mode === "preparing" ? "Getting ready" : "Processing dictation";

  return (
    <div className="capsule-stage">
      <span className="sr-only" role="status" aria-atomic="true">{announcement}</span>
      {mode !== "idle" && <div
        className={`capsule-pill capsule-${mode}${mode === "feedback" && feedback?.learned ? " is-learned" : ""}${isDraggable ? " is-draggable" : ""}${isCompact ? " is-compact" : ""}${isProcessing ? " is-processing" : ""}${isQuiet ? " capsule-quiet" : ""}${dismissing ? " is-dismissing" : ""}`}
        title={isDraggable ? "Hands-free listening · drag to reposition" : mode === "preparing" ? "Getting ready" : isCompact ? mode === "done" ? "Dictation complete" : "Processing dictation" : undefined}
        onPointerOver={() => interactWithFeedback("pointer", true)}
        onPointerLeave={() => interactWithFeedback("pointer", false)}
        onFocusCapture={() => interactWithFeedback("focus", true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) interactWithFeedback("focus", false);
        }}
        onPointerDown={event => {
          if (!isDraggable || event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button")) return;
          event.preventDefault(); // Moving the nonactivating panel must not take text focus.
          void getCurrentWindow().startDragging().catch(() => {});
        }}
      >
        <div className="capsule-emblem">
          <span
            className={`capsule-favicon${isRecording ? " is-listening" : ""}${isSpeaking ? " is-speaking" : ""}`}
            role="img" aria-label="Linty" aria-hidden={isCompact || isProcessing}
            style={{
              "--voice-left": isRecording ? 0.35 + brandLevels[0] * 0.65 : 1,
              "--voice-center": isRecording ? 0.35 + brandLevels[1] * 0.65 : 1,
              "--voice-right": isRecording ? 0.35 + brandLevels[2] * 0.65 : 1,
            } as CSSProperties}
            // Inline the same generated favicon artwork so its three strokes can move.
            dangerouslySetInnerHTML={{ __html: lintyFavicon }}
          />
          <span className="capsule-spinner" aria-hidden="true">
            <svg className="capsule-orbit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle className="capsule-orbit-track" cx="12" cy="12" r="8" />
              <path d="M12 4a8 8 0 1 1-8 8" />
            </svg>
          </span>
          <svg className="capsule-success" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6.5 12 3.7 3.7 7.3-7.4" pathLength="1" />
          </svg>
        </div>
        <div className="capsule-details" aria-hidden={isCompact} inert={isCompact}>
          <span className="capsule-divider" aria-hidden="true" />
          <div className="capsule-content" key={expandedQuiet ? "quiet" : expandedMode}>
            {expandedMode === "recording" && (expandedQuiet ? <span className="capsule-quiet-message" aria-hidden="true">Stopping…</span> : <>
              <div className="capsule-wave" aria-hidden="true">
                {levels.map((level, i) => <span key={i} style={{ transform: `scaleY(${0.1 + level * 0.9})`, opacity: 0.4 + level * 0.6 }} />)}
              </div>
              <span className="capsule-time" aria-hidden="true">{handsFree && <LockKeyhole size={10} strokeWidth={1.6} />}{formatDuration(duration)}</span>
            </>)}
            {expandedMode === "preparing" && <span className="capsule-message" aria-hidden="true">Getting ready…</span>}
            {expandedMode === "quiet-stop" && <span className="capsule-message" aria-hidden="true">No input · stopped</span>}
            {expandedMode === "error" && <div className="capsule-error-message"><CircleAlert size={15} aria-hidden="true" /><span title={errorMsg}>{errorMsg}</span></div>}
            {expandedMode === "feedback" && feedback && <div className="capsule-feedback-message">
              <strong>{feedback.title}</strong><span>{feedback.message}</span>
            </div>}
          </div>
          {expandedMode === "recording" && <button
            className={`capsule-action${expandedQuiet ? " capsule-action-countdown" : ""}`}
            aria-label="Finish dictation"
            aria-describedby={expandedQuiet ? "capsule-stop-description" : undefined}
            title={expandedQuiet ? `Finish now · stopping in ${remainingSeconds}s` : "Finish dictation"}
            disabled={stopping || !isRecording} onClick={() => {
              setStopping(true);
              void emit("capsule-stop", { generation: generationRef.current }).catch(() => setStopping(false));
            }}>
            {expandedQuiet ? <StopCountdown seconds={remainingSeconds} /> : <Square size={10} fill="currentColor" strokeWidth={0} />}
          </button>}
          {expandedQuiet && <span id="capsule-stop-description" className="sr-only">Automatically stops in {remainingSeconds} seconds. Click to finish now.</span>}
          {expandedMode === "feedback" && feedback?.actions?.map(action => <button
            key={action.action} className="capsule-action" aria-label={action.label} title={action.label}
            onClick={() => {
              void emitTo("main", "correction-feedback-action", action).then(() => {
                if (feedbackRef.current === feedback) dismiss();
              }).catch(() => {});
            }}>
            {action.action === "undo" ? <Undo2 size={13} /> : <BookOpen size={13} />}
          </button>)}
          {(expandedMode === "error" || expandedMode === "quiet-stop" || expandedMode === "feedback") && <button className="capsule-action" aria-label="Dismiss" onClick={dismiss}><X size={12} /></button>}
        </div>
      </div>}
    </div>
  );
}
