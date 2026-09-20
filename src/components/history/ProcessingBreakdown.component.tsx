import { reformatStatusLabel } from "@/lib/reformat.util";
import type { TranscriptRecord } from "@/types/transcript.types";

function measured(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

export function formatProcessingTime(value: number | null | undefined): string {
  if (!measured(value)) return "Not measured";
  return value < 1000
    ? `${Math.round(value).toLocaleString()} ms`
    : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

export function ProcessingBreakdown({ transcript }: { transcript: TranscriptRecord }) {
  const metrics = transcript.reformatting?.enabled ? transcript.reformatting : undefined;
  const stages: { label: string; time: number | undefined }[] = [];
  if (measured(transcript.sttTimeMs)) {
    stages.push({ label: "Speech recognition", time: transcript.sttTimeMs });
  }
  if (metrics) {
    stages.push({ label: "S1-mini reformatting", time: metrics.roundTripMs ?? transcript.reformatTimeMs });
  } else if ((transcript.correctionTimeMs ?? 0) > 0) {
    stages.push({ label: "Text refinement (previous version)", time: transcript.correctionTimeMs });
  }

  if (!stages.length && !measured(transcript.pasteTimeMs)) return null;

  return (
    <section className="processing-breakdown" aria-label="Processing time">
      <h3>Processing time</h3>
      <dl className="processing-stages">
        {measured(transcript.audioStopTimeMs) && <div><dt>Finishing recording</dt><dd>{formatProcessingTime(transcript.audioStopTimeMs)}</dd></div>}
        {measured(transcript.preparationTimeMs) && <div><dt>Waiting for models</dt><dd>{formatProcessingTime(transcript.preparationTimeMs)}</dd></div>}
        {stages.map(({ label, time }) => (
          <div key={label}><dt>{label}</dt><dd>{formatProcessingTime(time)}</dd></div>
        ))}
        {measured(transcript.pasteTimeMs) && (
          <div><dt>Delivery</dt><dd>{formatProcessingTime(transcript.pasteTimeMs)}</dd></div>
        )}
      </dl>
      {measured(transcript.releaseToInsertionMs) && <p className="processing-note">Stop request to confirmed insertion: {formatProcessingTime(transcript.releaseToInsertionMs)}</p>}
      <p className="processing-note">The total also includes time between stages. New dictations include finishing the recording and checking delivery.</p>
      {metrics && (
        <div className="processing-model">
          <h3>S1-mini by Superwhisper</h3>
          <p className="processing-note">These timings are included in reformatting above.</p>
          <dl className="processing-measurements">
            <div><dt>Result</dt><dd>{reformatStatusLabel(metrics)}</dd></div>
            <div><dt>Model loading</dt><dd>{formatProcessingTime(metrics.modelLoadMs)}</dd></div>
            <div><dt>Input processing</dt><dd>{formatProcessingTime(metrics.prefillMs)}</dd></div>
            <div><dt>Text generation</dt><dd>{formatProcessingTime(metrics.decodeMs)}</dd></div>
            <div><dt>Generation speed</dt><dd>{metrics.tokensPerSecond == null ? "Not measured" : `${metrics.tokensPerSecond.toFixed(1)} tokens/s`}</dd></div>
            <div><dt>Input / generated tokens</dt><dd>{metrics.inputTokens ?? "—"} / {metrics.generatedTokens ?? "—"}</dd></div>
            <div><dt>Words before / after</dt><dd>{metrics.inputWords} / {metrics.outputWords}</dd></div>
            <div><dt>Language setting</dt><dd>{metrics.requestedLanguage === "auto" ? "Auto-detect" : metrics.requestedLanguage}</dd></div>
            {metrics.detectedLanguage && <div><dt>Detected language</dt><dd>{metrics.detectedLanguage}</dd></div>}
            <div><dt>Layout</dt><dd>{metrics.options.context === "email" ? "Email" : "General text"} · {metrics.options.structure === "lists" ? "Lists allowed" : "Prose"}</dd></div>
            {metrics.reason && <div><dt>Skip / fallback detail</dt><dd>{metrics.reason}</dd></div>}
          </dl>
          <p className="processing-note">All measurements are included in History exports.</p>
        </div>
      )}
    </section>
  );
}
