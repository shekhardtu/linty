import { useCallback, useEffect, useId, useState } from "react";
import { Check, CheckCircle2, Copy, Loader2, Mic, Square } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "@/store/app.store";
import { useRecording } from "@/hooks/useRecording.hook";
import { useTranscription } from "@/hooks/useTranscription.hook";
import { useAudioInput } from "@/hooks/useAudioInput.hook";
import { WaveformVisualizer } from "@/components/WaveformVisualizer.component";
import { VoiceIllustration, TranscriptIllustration, type VoiceIllustrationState } from "@/components/shared/VoiceIllustration.component";
import "@/styles/microphone-test.css";

interface TestTranscript {
  generation: number;
  text: string;
  timestamp: number;
}

type Feedback = { kind: "success" | "empty" | "error"; message: string } | null;
const activeStatuses = new Set(["preparing", "recording", "transcribing", "correcting", "pasting"]);
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function MicrophoneTest({ focused = false }: { focused?: boolean }) {
  const headingId = useId();
  const quietSeconds = useAppStore(s => s.quietSeconds);
  const { isRecording, recordingDuration, startRecording, stopRecording } = useRecording();
  const { status, processAudio } = useTranscription();
  const { inputs } = useAudioInput();
  const [transcripts, setTranscripts] = useState<TestTranscript[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);

  // Keep this visit's results independent of the shared dictation reset timers.
  // Subscribe to transitions so identical phrases and very fast results are kept.
  useEffect(() => {
    let active = activeStatuses.has(useAppStore.getState().status);
    return useAppStore.subscribe((next, previous) => {
      if (next.status === previous.status && next.error === previous.error) return;
      if (activeStatuses.has(next.status)) {
        active = true;
        setFeedback(null);
      } else if (next.status === "done" && next.finalText.trim()) {
        active = false;
        const result = { generation: next.recordingGeneration, text: next.finalText, timestamp: Date.now() };
        setTranscripts(recent => [result, ...recent.filter(item => item.generation !== result.generation)].slice(0, 3));
        setFeedback({ kind: "success", message: "Your words are below. You can record again whenever you like." });
      } else if (next.status === "error") {
        active = false;
        setFeedback({ kind: "error", message: next.error || "Check your microphone and try again." });
      } else if (next.status === "idle" && active) {
        active = false;
        setFeedback({ kind: "empty", message: "Try speaking a little closer to your microphone, then stop when you’re finished." });
      }
    });
  }, []);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const isProcessing = !isRecording && activeStatuses.has(status);
  const handleToggle = useCallback(async () => {
    if (isRecording) {
      setStopping(true);
      try {
        const audio = await stopRecording();
        if (audio.sample_count > 0) await processAudio(audio);
      } finally {
        setStopping(false);
      }
    } else {
      setFeedback(null);
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording, processAudio]);

  const copy = async (transcript: TestTranscript) => {
    try {
      await writeText(transcript.text);
      setCopied(transcript.generation);
      setCopyError(null);
    } catch {
      setCopyError(transcript.generation);
    }
  };

  const title = isRecording ? "Listening to you…"
    : isProcessing ? status === "preparing" ? "Getting ready…" : "Turning your voice into text…"
    : feedback?.kind === "success" ? focused ? "Your transcript is ready" : "Your test is complete"
    : feedback?.kind === "error" ? "We couldn’t finish this recording"
    : feedback?.kind === "empty" ? "No transcript this time"
    : "Let’s try your microphone";
  const detail = isRecording ? "Speak naturally. Choose Stop & transcribe when you’re finished."
    : isProcessing ? "You can review your words here as soon as they’re ready."
    : feedback?.message ?? (focused ? "Start a recording whenever you’re ready." : "Record a short sentence to see how Linty hears you.");
  const buttonLabel = isRecording ? "Stop & transcribe" : isProcessing ? "Working…" : feedback?.kind === "error" || feedback?.kind === "empty" ? "Try again" : transcripts.length ? "Record again" : "Start recording";
  const illustrationState: VoiceIllustrationState = isRecording ? "recording" : isProcessing ? "processing" : feedback?.kind === "success" ? "complete" : feedback ? "attention" : "idle";
  const phaseLabel = isRecording ? "Listening" : isProcessing ? "Making words" : feedback?.kind === "success" ? "Captured" : feedback ? "Try again" : "Ready when you are";

  return (
    <section className="microphone-test" aria-labelledby={headingId} data-recording={isRecording} data-phase={illustrationState}>
      <header className="microphone-test-heading">
        <div className="microphone-test-intro">
          {focused && <span className="microphone-test-eyebrow">A little less typing. A little more you.</span>}
          <h2 id={headingId}>{focused ? <>Your voice.<br /><span>Your words.</span></> : "Microphone Test"}</h2>
          <p>{focused ? "Speak naturally. Take your time." : "Check your microphone and review what you said."}</p>
          <span className="microphone-test-device"><Mic size={13} aria-hidden="true" />{inputs?.selected || inputs?.defaultDevice || "System default microphone"}</span>
        </div>
        <VoiceIllustration state={illustrationState} />
      </header>

      <div className="microphone-test-recorder">
        <div className="microphone-test-recorder-topline" aria-hidden="true">
          <span className="microphone-test-phase"><span />{phaseLabel}</span>
          <span className="microphone-test-step">01 <span>/</span> Your voice</span>
        </div>
        <div className="microphone-test-controls">
          <div className="microphone-test-status" role="status" aria-atomic="true">
            <h3>{!isRecording && !isProcessing && feedback?.kind === "success" && <CheckCircle2 size={16} aria-hidden="true" />}{title}</h3>
            <p className={feedback?.kind === "error" ? "microphone-test-error" : undefined}>{detail}</p>
          </div>
          <button
            className="standard-button primary-button microphone-test-toggle"
            onClick={() => { void handleToggle(); }}
            aria-label={focused ? buttonLabel : `${isRecording ? "Stop" : "Start"} microphone test: ${buttonLabel}`}
            disabled={isProcessing || stopping}
          >
            {isRecording ? <Square size={13} fill="currentColor" aria-hidden="true" /> : isProcessing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            {buttonLabel}
          </button>
        </div>

        <div className="microphone-test-signal">
          {isRecording ? <WaveformVisualizer isActive fillWidth barCount={80} className="microphone-test-waveform" />
            : <div className="microphone-test-placeholder">{isProcessing ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /><span>Preparing your transcript</span></> : <><span className="microphone-test-baseline" /><span>{transcripts.length ? "Ready for your next recording" : "Your voice will appear here"}</span><span className="microphone-test-baseline" /></>}</div>}
          <div className="microphone-test-signal-caption">
            <span role="status">{isRecording ? quietSeconds >= 20 ? `No speech detected recently. Speak to continue · stopping in ${Math.max(0, 30 - quietSeconds)}s` : "Live microphone input" : isProcessing ? "Your previous transcripts stay below" : "Try saying: “I’m ready to turn my ideas into words.”"}</span>
            {isRecording && <time aria-label="Recording duration">{formatDuration(recordingDuration)}</time>}
          </div>
        </div>
      </div>

      <div className="microphone-test-history">
        <div className="microphone-test-history-heading"><h3><span className="microphone-test-section-number" aria-hidden="true">02</span>{focused ? "Your recent transcripts" : "Your test transcripts"}</h3><span>{transcripts.length} / 3</span></div>
        <p className="microphone-test-history-note">Your last 3 {focused ? "recordings" : "tests"} stay here until you leave this screen. Transcripts are also saved in History, where you can delete them.</p>
        {transcripts.length ? <ol aria-label={focused ? "Recent transcripts" : "Recent microphone test transcripts"}>
          {transcripts.map((transcript, index) => <li key={transcript.generation} className="microphone-test-transcript">
            <div className="microphone-test-transcript-heading">
              <div><span>{index === 0 ? "Latest" : "Earlier"} {focused ? "recording" : "test"}</span><time dateTime={new Date(transcript.timestamp).toISOString()}>{new Date(transcript.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>
              <button className="standard-button microphone-test-copy" onClick={() => { void copy(transcript); }} aria-label={`Copy ${index === 0 ? "latest" : `earlier ${index + 1}`} ${focused ? "recording" : "test"} transcript`}>
                {copied === transcript.generation ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                {copied === transcript.generation ? "Copied" : "Copy"}
              </button>
            </div>
            <p dir="auto">{transcript.text}</p>
            {copyError === transcript.generation && <p className="microphone-test-error" role="alert">Couldn’t copy. Try again, or select the text to copy it.</p>}
          </li>)}
        </ol> : <div className="microphone-test-empty"><TranscriptIllustration /><div><h4>A little space for your next idea.</h4><p>Your first transcript will appear here after you stop recording.</p></div></div>}
      </div>
    </section>
  );
}
