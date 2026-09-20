import { Select } from "@/components/shared/Select.component";
import { LegalNotice } from "@/components/shared/LegalNotice.component";
import { useState, useEffect } from "react";
import {
  ChevronDown,
  Mic,
  ShieldCheck,
} from "lucide-react";
import { useSettings } from "@/hooks/useSettings.hook";
import { audioInputOptions, useAudioInput } from "@/hooks/useAudioInput.hook";
import { useAppStore } from "@/store/app.store";
import { Toggle } from "@/components/shared/Toggle.component";
import { SegmentedControl } from "@/components/shared/SegmentedControl.component";
import {
  SectionHeader,
  SectionCard,
  SettingRow,
  ValueBadge,
} from "@/components/shared/SettingsLayout.component";
import { SETTINGS_SECTIONS } from "@/config/navigation.config";
import {
  PageLayout,
  PageHeader,
  SectionHeading,
} from "@/components/shared/PageLayout.component";
import { ProcessingDetails } from "@/components/settings/ProcessingDetails.component";
import { ThemePreview } from "@/components/settings/ThemePreview.component";
import { BrandMark } from "@/components/shared/BrandMark.component";
import { HistoryStorage } from "@/components/settings/HistoryStorage.component";
import { AudioStorage } from "@/components/settings/AudioStorage.component";
import { DictationLanguages } from "@/components/settings/DictationLanguages.component";
import { modelLabel } from "@/lib/model-labels.util";
import type { ThemePreference } from "@/store/slices/settings.slice";

const THEME_SEGMENTS = [
  {
    value: "light" as ThemePreference,
    label: "Light",
    icon: <ThemePreview theme="light" />,
  },
  {
    value: "dark" as ThemePreference,
    label: "Dark",
    icon: <ThemePreview theme="dark" />,
  },
  {
    value: "system" as ThemePreference,
    label: "System",
    icon: <ThemePreview theme="system" />,
  },
];

const IDLE_UNLOAD_OPTIONS = [
  { value: 0, label: "Never" },
  { value: 5, label: "After 5 minutes" },
  { value: 15, label: "After 15 minutes" },
  { value: 30, label: "After 30 minutes" },
  { value: 60, label: "After 1 hour" },
];

export function SettingsPage() {
  const section = useAppStore((s) => s.settingsSection);
  const [visited, setVisited] = useState(() => new Set([section]));
  useEffect(() => {
    setVisited((old) => (old.has(section) ? old : new Set([...old, section])));
  }, [section]);
  const metadata = SETTINGS_SECTIONS.find((item) => item.id === section)!;
  return (
    <PageLayout reading className={`settings-page settings-${section}`}>
      <PageHeader page="settings" title={metadata.label} description={metadata.description} />
      <div className="settings-pane">
        {(visited.has("general") || section === "general") && (
          <div hidden={section !== "general"}>
            <DictationSection />
          </div>
        )}
        {(visited.has("audio") || section === "audio") && (
          <div hidden={section !== "audio"}>
            <AudioSection />
          </div>
        )}
        {(visited.has("appearance") || section === "appearance") && (
          <div hidden={section !== "appearance"}>
            <AppearanceSection />
          </div>
        )}
        {(visited.has("privacy") || section === "privacy") && (
          <div hidden={section !== "privacy"}>
            <PrivacySection />
          </div>
        )}
      </div>
    </PageLayout>
  );
}

/* ═══ Dictation ═══ */
function DictationSection() {
  const { modelIdleUnloadMinutes, saveModelIdleUnloadMinutes } = useSettings();
  const loadedModel = useAppStore((state) => state.loadedModelFilename);
  return <div className="settings-section dictation-preferences">
    <DictationLanguages />
    <details className="dictation-advanced">
      <summary>Advanced <ChevronDown size={14} aria-hidden="true" /></summary>
      <div className="dictation-advanced-content">
        <SettingRow label="Free memory when idle" description="Releases speech and cleanup models after inactivity. They prepare again when needed."
          right={<Select label="Free memory when idle" value={modelIdleUnloadMinutes}
            onChange={(minutes) => { void saveModelIdleUnloadMinutes(minutes).catch(() => {}); }} options={IDLE_UNLOAD_OPTIONS} />} />
        <div className="dictation-model-details">
          <span className="field-label">Speech support</span>
          <p>{loadedModel ? `Active model: ${modelLabel(loadedModel)}` : "Speech support prepares automatically when needed."}</p>
          <p>Linty selects speech support for your language and this Mac. Downloads are reused across compatible languages.</p>
        </div>
      </div>
    </details>
  </div>;
}

/* ═══ Audio ═══ */
function AudioSection() {
  const { inputs, saving, error, select } = useAudioInput();
  const recording = useAppStore((state) => state.isRecording);
  const selected = inputs?.selected;
  const available = !selected || inputs?.devices.some((device) => device.name === selected && device.selectable);
  const options = audioInputOptions(inputs);
  return (
    <div className="settings-section">
      <SectionHeader title="Audio & Input" />
      <div className="settings-feature">
        <span className="feature-symbol">
          <Mic size={35} />
        </span>
        <div>
          <span className="eyebrow">INPUT SOURCE</span>
          <h3>{selected ?? "System microphone"}</h3>
          <p>{selected ? "This microphone is used for dictation in Linty." : "Follows the microphone selected in macOS."}</p>
        </div>
      </div>

      <SectionCard>
        <SettingRow
          label="Input device"
          description={recording ? "Stop recording to change the microphone." : "Also available in Linty’s menu bar menu."}
          right={<Select label="Input device" value={selected ?? ""} options={options} onChange={select} disabled={!inputs || saving || recording} />}
          className="border-b border-border-subtle"
        />
        <SettingRow
          label="Sample quality"
          description="Optimized for speech recognition"
          right={<ValueBadge>16 kHz</ValueBadge>}
        />
      </SectionCard>
      {(error || !available) && <p role="status" className="text-sm text-warning">{error || "Your selected microphone is unavailable or has an ambiguous name. Choose another input or System Default."}</p>}
    </div>
  );
}

/* ═══ Privacy ═══ */
function PrivacySection() {
  const {
    trackApplicationUsage,
    saveTrackApplicationUsage,
    dictionaryEnabled,
    saveDictionaryEnabled,
    autoLearnWords,
    saveAutoLearnWords,
    observeCorrections,
    saveObserveCorrections,
  } = useSettings();
  const addToast = useAppStore((s) => s.addToast);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const savePreference = (work: Promise<void>) =>
    work.catch(() =>
      addToast({ type: "error", message: "Could not save that preference." }),
    );
  return (
    <div className="settings-section">
      <SectionHeader title="Privacy & Storage" />
      <div className="privacy-feature">
        <ShieldCheck size={27} />
        <div>
          <h3>Your words are yours.</h3>
          <p>
            Speech recognition and optional text cleanup run on this Mac.
            Linty does not upload your recordings or transcripts. Model downloads
            and automatic update checks connect to external hosts.
          </p>
        </div>
      </div>
      <LegalNotice />
      <SectionCard>
        <Toggle
          enabled={trackApplicationUsage}
          onChange={(enabled) => {
            saveTrackApplicationUsage(enabled).catch(() =>
              addToast({
                type: "error",
                message: "Could not save app attribution preference.",
              }),
            );
          }}
          label="Attribute dictations to apps"
          description="Save the active app’s name when dictation starts. See words and dictation time per app in your dashboard."
        />
      </SectionCard>
      <SectionCard>
        <div className="border-b border-border-subtle">
          <Toggle
            enabled={dictionaryEnabled}
            onChange={(enabled) =>
              savePreference(saveDictionaryEnabled(enabled))
            }
            label="Apply my dictionary"
            description="Fix words you have corrected before and teach the speech engine your words. Parakeet fetches a 100 MB vocabulary model the first time."
          />
        </div>
        <div className="border-b border-border-subtle">
          <Toggle
            enabled={autoLearnWords}
            onChange={(enabled) => savePreference(saveAutoLearnWords(enabled))}
            label="Learn new words automatically"
            description="Save reusable spelling corrections automatically. Verified spelling fixes in other apps can be learned after one edit; History corrections need two sightings, or one for names."
          />
        </div>
        <Toggle
          enabled={observeCorrections}
          onChange={(enabled) =>
            savePreference(saveObserveCorrections(enabled))
          }
          label="Learn from corrections in other apps"
          description="Watch edits in supported text fields for up to two minutes after dictation. Uses Accessibility permission and compares text in memory; the full field is never saved. Verified corrections are collected when you finish editing. Some apps and terminal fields are unsupported."
        />
        <div className="pb-4">
          <button
            className="text-link"
            onClick={() => setCurrentView("dictionary")}
          >
            Open your dictionary
          </button>
        </div>
      </SectionCard>
      <ProcessingDetails />
      <AudioStorage />
      <HistoryStorage />
      <div className="rounded-xl border border-border-subtle bg-bg-elevated px-4 py-3 text-[12px] leading-relaxed text-text-secondary">
        App attribution records only the app name and identifier, once per
        dictation. It does not read window titles, browser URLs, or track time
        spent in other apps. Turning it off affects new dictations; deleting
        history removes its app statistics too.
      </div>
    </div>
  );
}

/* ═══ Appearance ═══ */
function AppearanceSection() {
  const { theme, saveTheme } = useSettings();

  return (
    <div className="settings-section">
      <SectionHeader title="Appearance" />
      <div className="appearance-specimen">
        <BrandMark />
        <p>
          A little warmth.
          <br />
          <span>A place for your words.</span>
        </p>
        <span className="heading-rule" aria-hidden="true" />
      </div>

      <SectionCard>
        <SectionHeading
          title="Choose your appearance"
          description="Light, dark, or follow your Mac."
        />
        <SegmentedControl
          label="Appearance"
          className="theme-picker"
          segments={THEME_SEGMENTS}
          value={theme}
          onChange={saveTheme}
        />
        <SettingRow
          label="Accent color"
          description="Teal, for interactions and recording"
          right={
            <div className="h-5 w-5 rounded-full bg-accent border border-accent-soft" />
          }
        />
      </SectionCard>
    </div>
  );
}
