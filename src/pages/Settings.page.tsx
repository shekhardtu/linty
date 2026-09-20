import { Select } from "@/components/shared/Select.component";
import { useState, useEffect } from "react";
import {
  Languages,
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
import {
  AUTO_LANGUAGE,
  nativeLanguageLabel,
  modelSupportsLanguage,
  languageLabel,
} from "@/lib/languages.util";
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
import { Reformatting } from "@/components/settings/Reformatting.component";
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
            <GeneralSection showLanguages={section === "general"} />
          </div>
        )}
        {(visited.has("audio") || section === "audio") && (
          <div hidden={section !== "audio"}>
            <AudioSection />
          </div>
        )}
        {(visited.has("language") || section === "language") && (
          <div hidden={section !== "language"}>
            <LanguageSection />
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

/* ═══ General ═══ */
function GeneralSection({ showLanguages }: { showLanguages: boolean }) {
  const { modelIdleUnloadMinutes, saveModelIdleUnloadMinutes } = useSettings();
  return <div className="settings-section">
    {showLanguages && <DictationLanguages />}
    <Reformatting />
    <SectionCard>
      <SettingRow label="Free memory when idle" description="Releases speech and cleanup models after inactivity. They prepare automatically when needed."
        right={<Select label="Free memory when idle" value={modelIdleUnloadMinutes}
          onChange={(minutes) => { void saveModelIdleUnloadMinutes(minutes).catch(() => {}); }} options={IDLE_UNLOAD_OPTIONS} />} />
    </SectionCard>
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

/* ═══ Language ═══ */

function LanguageSection() {
  const active = useAppStore(state => state.settingsSection === "language");
  const { transcriptionLanguage, autoDetectLanguages } = useSettings();
  const loadedModel = useAppStore((state) => state.loadedModelFilename);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const dictating = useAppStore((state) => state.isRecording || ["preparing", "recording", "transcribing", "correcting", "pasting"].includes(state.status));
  const ready = modelSupportsLanguage(loadedModel, transcriptionLanguage);

  return <div className="settings-section language-settings">
    <SectionHeader title="Language" />
    <div className="language-feature">
      <div className="language-symbol" aria-hidden="true"><Languages size={32} /></div>
      <div>
        <span className="eyebrow">YOUR DICTATION LANGUAGE</span>
        <h3>{languageLabel(transcriptionLanguage)}{transcriptionLanguage !== AUTO_LANGUAGE && nativeLanguageLabel(transcriptionLanguage).toLowerCase() !== languageLabel(transcriptionLanguage).toLowerCase() && <span className="language-native" lang={transcriptionLanguage}>{nativeLanguageLabel(transcriptionLanguage)}</span>}</h3>
        <p>{transcriptionLanguage === AUTO_LANGUAGE ? autoDetectLanguages.length ? `Auto-detect chooses from ${autoDetectLanguages.map(languageLabel).join(", ")}.` : "Choose up to three frequently spoken languages for Auto-detect." : "Your voice, in your own words."}</p>
      </div>
    </div>
    {active && <DictationLanguages />}
    <div className="language-notes">
      <div><h4>One language or auto-detect</h4><p>Choose a language for a more focused transcription, or use Auto-detect when you switch between languages. Accuracy varies by language and recording.</p></div>
      <div><h4>Prepared once, ready again</h4><p>Many languages share the same speech support. Downloads are reused when you change languages or return to an earlier choice.</p></div>
    </div>
    <div className="language-actions">
      <button className="standard-button" disabled={!ready || dictating} onClick={() => setCurrentView("system-check")}><Mic size={15} />Try dictation</button>
      <span>Check your microphone and try a short recording.</span>
    </div>
    <details className="language-details">
      <summary>Technical details</summary>
      <p>{loadedModel ? `Active speech model: ${modelLabel(loadedModel)}` : "Speech support is being prepared."}</p>
      <p>Speech support is selected automatically for your language and this Mac. All speech recognition runs on this Mac.</p>
    </details>
  </div>;
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
            Your audio, transcript history, and dictionary stay on your device.
          </p>
        </div>
      </div>
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
