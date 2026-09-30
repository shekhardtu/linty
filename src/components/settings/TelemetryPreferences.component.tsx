import { useState } from "react";
import { Toggle } from "@/components/shared/Toggle.component";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { saveTelemetry, useTelemetry } from "@/services/telemetry.service";

/** Setup uses a draft; only its confirmation button saves consent. */
export function TelemetryChoice({ enabled, onChange, disabled = false }: {
  enabled: boolean; onChange: (enabled: boolean) => void; disabled?: boolean;
}) {
  return <SectionCard>
    <Toggle enabled={enabled} disabled={disabled} onChange={onChange}
      label="Share telemetry"
      description="Send limited usage and error statistics to PostHog, using a random ID to count returning installations. Never recordings or transcripts." />
    <details className="px-4 pb-3 text-left text-[12px] text-text-secondary leading-relaxed">
      <summary className="cursor-pointer text-text-primary">What is shared?</summary>
      <p className="mt-2">App launches, Linty page names, setup completion, dictation outcomes, duration ranges, speech engine, cleanup use, and fixed failure categories. Events include Linty’s version and build architecture.</p>
      <p className="mt-2">A random installation ID links events over time to measure returning installations. It is not your name, account, or hardware identifier. This means activity can be linked, even though it is not labelled with your identity.</p>
      <p className="mt-2">Recordings, transcripts, clipboard contents, dictionary words, file paths, and names of other apps are never included. No raw error messages, logs, memory dumps, screenshots, session replay, or automatic click tracking. Full native crash reports are not included; Rust panic reports are best effort.</p>
      <p className="mt-2">You can turn this off anytime in Privacy &amp; storage. Turning it off deletes the ID and discards unsent events. Events already received by PostHog remain there. Requests expose your network address to PostHog, even though the payload suppresses IP storage and geolocation.</p>
    </details>
  </SectionCard>;
}

export function TelemetryPreferences() {
  const { loaded, available, enabled, decided, saving } = useTelemetry();
  const [draft, setDraft] = useState(true);
  const [error, setError] = useState("");
  const [failedChoice, setFailedChoice] = useState<boolean | null>(null);
  const save = (next: boolean) => {
    setError("");
    setFailedChoice(null);
    void saveTelemetry(next).catch((reason: Error) => { setError(reason.message); setFailedChoice(next); });
  };
  return <div>
    <TelemetryChoice enabled={decided ? enabled : draft} disabled={!loaded || (!available && !enabled) || saving}
      onChange={decided ? save : setDraft} />
    {!decided && available && <div className="px-4 pb-3 text-left">
      <p className="text-[12px] text-text-secondary mb-2">Nothing is sent until you confirm this choice.</p>
      <button className="standard-button" disabled={saving} onClick={() => save(draft)}>{saving ? "Saving…" : "Confirm preference"}</button>
    </div>}
    {loaded && !available && <p className="px-4 pb-3 text-[12px] text-text-muted text-left">Sharing is unavailable in this build.</p>}
    {error && <p role="alert" className="px-4 pb-3 text-[12px] text-error text-left">{error}</p>}
    {failedChoice !== null && <button className="standard-button ml-4 mb-3" disabled={saving} onClick={() => save(failedChoice)}>Retry saving</button>}
  </div>;
}
