import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UsageResult } from "@/types/history.types";
import { useAppStore } from "@/store/app.store";
import { saveSetting } from "@/services/settings-store.service";
import { normalizeAppStyles, normalizeSnippets, WRITING_STYLES } from "@/lib/dictation-personalization.util";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { Select } from "@/components/shared/Select.component";
import { Toggle } from "@/components/shared/Toggle.component";
import type { ReformatStyle } from "@/types/reformat.types";
import "./dictation-personalization.css";

const COMMON_APPS = [
  { value: "com.apple.mail", label: "Mail" },
  { value: "com.apple.Notes", label: "Notes" },
  { value: "com.tinyspeck.slackmacgap", label: "Slack" },
  { value: "com.apple.Safari", label: "Safari" },
  { value: "com.google.Chrome", label: "Google Chrome" },
  { value: "com.microsoft.Outlook", label: "Microsoft Outlook" },
  { value: "com.microsoft.VSCode", label: "Visual Studio Code" },
  { value: "com.todesktop.230313mzl4w4u92", label: "Cursor" },
  { value: "dev.zed.Zed", label: "Zed" },
  { value: "com.apple.dt.Xcode", label: "Xcode" },
];

export function DictationPersonalization() {
  const snippets = useAppStore((s) => s.voiceSnippets);
  const profiles = useAppStore((s) => s.appStyleProfiles);
  const tracking = useAppStore((s) => s.trackApplicationUsage);
  const cleanup = useAppStore((s) => s.reformatEnabled);
  const defaultStyle = useAppStore((s) => s.reformatStyle);
  const historyRevision = useAppStore((s) => s.historySnapshot.revision);
  const cacheEpoch = useAppStore((s) => s.historyCacheEpoch);
  const [usedApps, setUsedApps] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let stale = false;
    setUsedApps([]);
    // Existing local history only: this neither scans installed apps nor starts observation.
    void invoke<UsageResult>("history_usage", { start: 0, end: Date.now(), buckets: [] }).then(result => {
      if (!stale) setUsedApps(result.applications.flatMap(app => app.bundleId ? [{ value: app.bundleId, label: app.name }] : []));
    }).catch(() => { /* Common choices remain usable if local history is unavailable. */ });
    return () => { stale = true; };
  }, [historyRevision, cacheEpoch]);
  const apps = useMemo(() => {
    const choices = new Map(COMMON_APPS.map(app => [app.value, app.label]));
    for (const app of usedApps) choices.set(app.value, app.label);
    for (const profile of profiles) {
      if (!choices.has(profile.bundleId)) {
        const segments = profile.bundleId.split(".");
        const fallback = segments[segments.length - 1] || "Custom app";
        choices.set(profile.bundleId, fallback.charAt(0).toUpperCase() + fallback.slice(1));
      }
    }
    return [...choices].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [usedApps, profiles]);
  const appName = (id: string) => apps.find(app => app.value === id)?.label ?? "Custom app";
  const cursorAware = useAppStore((s) => s.cursorAwareInsertion);
  const ideHints = useAppStore((s) => s.ideVocabularyHints);
  const editing = useAppStore((s) => s.selectedTextEditing);
  const [phrase, setPhrase] = useState("");
  const [text, setText] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState("");
  const [style, setStyle] = useState<ReformatStyle>("semi-formal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (work: () => Promise<void>) => {
    setSaving(true); setError(null);
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : "Could not save. Try again."); }
    finally { setSaving(false); }
  };
  const remove = (button: HTMLButtonElement, work: () => Promise<void>) => save(async () => {
    const row = button.closest("li");
    const animation = !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? row?.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-3px)" }], { duration: 140, fill: "forwards" }) : undefined;
    try {
      await animation?.finished;
      await work();
    } finally { animation?.cancel(); }
  });
  const saveSnippet = () => save(async () => {
    const entry = { id: editId ?? crypto.randomUUID(), phrase, text };
    const next = [...snippets.filter((s) => s.id !== entry.id), entry];
    const valid = normalizeSnippets(next);
    if (valid.length !== next.length) throw new Error("Use a unique spoken phrase (up to 120 characters) and text (up to 10,000 characters). Maximum 100 snippets.");
    await saveSetting("voiceSnippets", valid);
    setPhrase(""); setText(""); setEditId(null);
  });
  const saveProfile = () => save(async () => {
    const entry = { bundleId: bundleId.trim(), style };
    const next = [...profiles.filter((p) => p.bundleId !== entry.bundleId), entry];
    const valid = normalizeAppStyles(next);
    if (valid.length !== next.length) throw new Error("Choose an app for this writing style. Maximum 100 app styles.");
    await saveSetting("appStyleProfiles", valid); setBundleId("");
  });
  return <div className="personalization-settings">
    <SectionCard>
      <h3>Voice snippets</h3>
      <p className="cleanup-caption">Say a whole phrase by itself to insert your saved text. For example, “my signature”. Snippets stay on this Mac and keep their original formatting.</p>
      <ul className="personalization-list" aria-label="Saved voice snippets">
        {snippets.map((entry) => <li key={entry.id}><div><strong>{entry.phrase}</strong><p>{entry.text}</p></div><div className="personalization-actions">
          <button type="button" className="standard-button" disabled={saving} onClick={() => { setEditId(entry.id); setPhrase(entry.phrase); setText(entry.text); }}>Edit <span className="sr-only">{entry.phrase}</span></button>
          <button type="button" className="standard-button" disabled={saving} onClick={(event) => void remove(event.currentTarget, async () => { await saveSetting("voiceSnippets", snippets.filter((s) => s.id !== entry.id)); if (editId === entry.id) { setEditId(null); setPhrase(""); setText(""); } })}>Delete <span className="sr-only">{entry.phrase}</span></button>
        </div></li>)}
      </ul>
      <form className="personalization-form" onSubmit={(e) => { e.preventDefault(); void saveSnippet(); }}>
        <label>Spoken phrase<input required maxLength={120} value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="my signature" /></label>
        <label>Text to insert<textarea aria-label="Text to insert" required maxLength={10000} rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div className="personalization-actions"><button className="standard-button primary-button" disabled={saving}>{editId ? "Save snippet" : "Add snippet"}</button>
          {editId && <button type="button" className="standard-button" onClick={() => { setEditId(null); setPhrase(""); setText(""); }}>Cancel edit</button>}</div>
      </form>
    </SectionCard>
    <SectionCard>
      <h3>Writing style by app</h3>
      <p className="cleanup-caption">Choose how Linty writes in each app. Other apps use your default style ({WRITING_STYLES.find((s) => s.value === defaultStyle)?.label}). Browser tabs share their browser’s style. Requires text cleanup and app attribution.</p>
      {(!tracking || !cleanup) && <p className="cleanup-caption" role="status">App styles are paused until text cleanup and app attribution are enabled.</p>}
      <ul className="personalization-list" aria-label="App writing styles">{profiles.map((entry) => <li key={entry.bundleId}><span>{appName(entry.bundleId)} · {WRITING_STYLES.find((s) => s.value === entry.style)?.label}</span><div className="personalization-actions">
        <button type="button" className="standard-button" disabled={saving} onClick={() => { setBundleId(entry.bundleId); setStyle(entry.style); }}>Edit <span className="sr-only">{appName(entry.bundleId)} style</span></button>
        <button type="button" className="standard-button" disabled={saving} onClick={(event) => void remove(event.currentTarget, async () => { await saveSetting("appStyleProfiles", profiles.filter((p) => p.bundleId !== entry.bundleId)); if (bundleId === entry.bundleId) setBundleId(""); })}>Remove <span className="sr-only">{appName(entry.bundleId)} style</span></button>
      </div></li>)}</ul>
      <form className="personalization-form" onSubmit={(e) => { e.preventDefault(); void saveProfile(); }}>
        <Select label="App" value={bundleId} disabled={saving} onChange={(id) => { setBundleId(id); setStyle(profiles.find(profile => profile.bundleId === id)?.style ?? defaultStyle); }} options={[{ value: "", label: "Choose an app", disabled: true }, ...apps]} />
        <p className="cleanup-caption">Common apps and apps from your local dictation history appear here. For another app, dictate there with app attribution enabled, then return here.</p>
        <Select label="App writing style" value={style} onChange={setStyle} options={WRITING_STYLES} />
        <button className="standard-button" disabled={saving || !bundleId}>Save app style</button>
      </form>
    </SectionCard>
    <SectionCard>
      <Toggle enabled={cursorAware} disabled={saving} label="Adapt text at the cursor" description="Adjust spacing and sentence casing in supported text fields; code and terminal apps keep literal text." onChange={(value) => void save(() => saveSetting("cursorAwareInsertion", value))} />
      <Toggle enabled={ideHints} disabled={saving} label="Use selected IDE vocabulary" description="Use identifiers in selected code as temporary hints for your next dictation in supported editors. Nothing is added to your dictionary." onChange={(value) => void save(() => saveSetting("ideVocabularyHints", value))} />
      <Toggle enabled={editing} disabled={saving} label="Edit selected text with your voice" description="Select text and say “Linty uppercase”, “Linty lowercase”, “Linty sentence case”, “Linty trim”, or “Linty bullet list”. Review the preview before applying." onChange={(value) => void save(() => saveSetting("selectedTextEditing", value))} />
    </SectionCard>
    {error && <p role="alert" className="cleanup-error">{error}</p>}
  </div>;
}
