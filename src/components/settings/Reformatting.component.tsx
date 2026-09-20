import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { useSettings } from "@/hooks/useSettings.hook";
import { useAppStore } from "@/store/app.store";
import { Toggle } from "@/components/shared/Toggle.component";
import { Select } from "@/components/shared/Select.component";
import { SectionCard, SettingRow } from "@/components/shared/SettingsLayout.component";
import { languageLabel } from "@/lib/languages.util";
import { supportsLocalCleanup } from "@/lib/reformat.util";
import { downloadCleanupModel } from "@/services/model-download.service";
import type { CleanupMode, ReformatContext, ReformatStyle } from "@/types/reformat.types";

interface ModelStatus { downloaded: boolean; downloading: boolean; progress: number }

function modelError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/command.*(?:not found|unknown)|unknown.*command/i.test(detail)) {
    return "This running version of Linty does not include S1-mini yet. Restart Linty after updating the app.";
  }
  return detail || "Could not update text cleanup. Try again.";
}

export function Reformatting({ disabled: languagePreparing = false }: { disabled?: boolean }) {
  const {
    reformatEnabled, reformatStyle, reformatLists, reformatContext, saveReformatSetting,
    saveCleanupMode, transcriptionLanguage, modelIdleUnloadMinutes,
  } = useSettings();
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [pendingLocal, setPendingLocal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useAppStore((s) => s.isRecording || ["preparing", "transcribing", "correcting", "pasting"].includes(s.status));
  const activeMode: CleanupMode = reformatEnabled ? "local" : "off";
  const disabled = languagePreparing || saving || busy || downloading;
  const localSupported = supportsLocalCleanup(transcriptionLanguage);
  const showSetup = pendingLocal && localSupported;
  const selectedMode = showSetup ? "local" : activeMode;
  const localPaused = activeMode === "local" && !localSupported;

  useEffect(() => { if (reformatEnabled) setPendingLocal(false); }, [reformatEnabled]);
  const refresh = useCallback(async () => {
    const status = await invoke<ModelStatus>("s1_model_status");
    setModel(status);
    setDownloading(status.downloading);
    setProgress(status.progress);
    return status;
  }, []);
  useEffect(() => {
    // An unavailable optional model must not block choosing unmodified text.
    void refresh().then((status) => {
      if (status.downloading || (!status.downloaded && useAppStore.getState().reformatEnabled)) setPendingLocal(true);
    }).catch(() => {});
    const unlisten = listen<number>("s1-download-progress", (event) => setProgress(event.payload));
    return () => { void unlisten.then((stop) => stop()).catch(() => {}); };
  }, [refresh]);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [downloading, refresh]);

  const choose = async (mode: CleanupMode) => {
    setSaving(true); setError(null);
    try {
      if (mode === "local") {
        const status = await refresh();
        if (!status.downloaded) { setPendingLocal(true); return; }
        setPendingLocal(true);
        setPreparing(true);
      }
      await saveCleanupMode(mode);
      setPendingLocal(false);
    } catch (error) { setError(modelError(error)); }
    finally { setSaving(false); setPreparing(false); }
  };
  const downloadAndEnable = async () => {
    setSaving(true); setDownloading(true); setProgress(0); setError(null);
    try {
      await downloadCleanupModel();
      await refresh();
      setPreparing(true);
      await saveCleanupMode("local");
      setPendingLocal(false);
    } catch (error) { setError(modelError(error)); }
    finally { setSaving(false); setDownloading(false); setPreparing(false); }
  };
  const saveOption = async <K extends "reformatStyle" | "reformatLists" | "reformatContext",>(key: K, value: ReturnType<typeof useAppStore.getState>[K]) => {
    setSaving(true); setError(null);
    try { await saveReformatSetting(key, value); }
    catch { setError("Could not save cleanup settings. Try again."); }
    finally { setSaving(false); }
  };
  const description = selectedMode === "off"
    ? "Keep your transcript as spoken, without extra rewriting."
    : "Remove fillers and tidy grammar, punctuation and lists on your Mac. English only.";

  return (
    <div className="dictation-settings">
      <SectionCard className="cleanup-choice">
        <SettingRow label="Text cleanup" description={description} right={
          <Select<CleanupMode> label="Text cleanup" value={selectedMode} disabled={disabled}
            onChange={(mode) => void choose(mode)} options={[
              { value: "off", label: "Keep as spoken" },
              { value: "local", label: localPaused ? "Clean up on this Mac (paused)" : "Clean up on this Mac", disabled: !localSupported },
            ]} />
        } />
        {activeMode === "local" && !showSetup && <p className="cleanup-caption">S1-mini by Superwhisper</p>}
        {preparing && <p className="cleanup-caption flex items-center gap-2" role="status">
          <Loader2 size={14} className="animate-spin" /> Preparing on-device cleanup…
        </p>}
        {showSetup && !preparing && <div className="cleanup-setup">
          <p>Download S1-mini by Superwhisper to use on-device cleanup. About 496 MB, once.</p>
          <p className="cleanup-caption">Your current dictation stays unchanged until setup is complete.</p>
          <div className="cleanup-setup-actions">
            <button type="button" className="standard-button primary-button" disabled={disabled} onClick={() => void downloadAndEnable()}>
              {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {downloading ? `Downloading… ${Math.floor(progress)}%` : model?.downloaded ? "Use on-device cleanup" : "Download & use"}
            </button>
            <button type="button" className="standard-button" disabled={disabled} onClick={() => { setPendingLocal(false); setError(null); }}>Cancel</button>
          </div>
          {downloading && <progress aria-label="S1-mini download progress" value={progress} max={100} />}
        </div>}
      </SectionCard>

      {error && <p className="cleanup-error" role="alert">{error}</p>}
      {!localSupported && (
        <p className="cleanup-caption" role="status">{localPaused
          ? `On-device cleanup is paused for ${languageLabel(transcriptionLanguage)}. Your transcript stays as spoken. Cleanup resumes when you select English.`
          : "On-device cleanup supports English only. Select English to use it."}</p>
      )}

      {activeMode !== "off" && !showSetup && !localPaused && <details className="cleanup-options" key={activeMode}>
        <summary>Customize cleanup <ChevronDown size={14} /></summary>
        <div className="cleanup-options-content">
            <SettingRow label="Writing style" right={<Select<ReformatStyle> label="Reformatting writing style" value={reformatStyle} disabled={disabled} onChange={(style) => void saveOption("reformatStyle", style)} options={[
              { value: "casual", label: "Casual" }, { value: "semi-casual", label: "Semi-casual" },
              { value: "semi-formal", label: "Standard" }, { value: "formal", label: "Formal" },
            ]} />} />
            <SettingRow label="Layout" description={reformatContext === "auto" ? "Email layout in supported mail apps when app tracking is on; general text elsewhere." : undefined} right={<Select<ReformatContext> label="Reformatting layout" value={reformatContext} disabled={disabled} onChange={(context) => void saveOption("reformatContext", context)} options={[
              { value: "auto", label: "Automatic" }, { value: "general", label: "General text" }, { value: "email", label: "Email" },
            ]} />} />
            <Toggle enabled={reformatLists} disabled={disabled} onChange={(enabled) => void saveOption("reformatLists", enabled)} label="Use lists when appropriate" description="Turn clear enumerations into text lists." />
            <p className="cleanup-caption">
              {modelIdleUnloadMinutes === 0 ? "The cleanup model stays in memory until you turn it off." : `The cleanup model frees its memory after ${modelIdleUnloadMinutes} minutes idle and reloads when needed.`}
            </p>
        </div>
      </details>}
    </div>
  );
}
