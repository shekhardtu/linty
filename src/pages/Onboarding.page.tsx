import { BrandMark, SoundPattern } from "@/components/shared/BrandMark.component";
import { LegalNotice } from "@/components/shared/LegalNotice.component";
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { Mic, Shield, CheckCircle2, ArrowRight, Loader2, ExternalLink, Keyboard, Languages } from "lucide-react";
import {
  checkMicrophonePermission,
  requestMicrophonePermission,
  checkAccessibility,
  requestAccessibility,
  reinitFnKeyMonitor,
  openSystemSettings,
} from "@/services/permissions.service";
import { useAppStore } from "@/store/app.store";
import { useSettings } from "@/hooks/useSettings.hook";
import { formatTriggerLabel } from "@/lib/trigger.util";
import { FnKeyConflictWarning } from "@/components/shared/FnKeyConflictWarning.component";
import { TriggerKeyPicker } from "@/components/shared/TriggerKeyPicker.component";
import { cn } from "@/lib/utils";
import { FrequentLanguages } from "@/components/shared/FrequentLanguages.component";
import { LanguagePicker } from "@/components/shared/LanguagePicker.component";
import { AUTO_LANGUAGE, validAutoDetectLanguages } from "@/lib/languages.util";
import { LanguageReadiness } from "@/components/settings/LanguageReadiness.component";
import { languagePreparation } from "@/services/language-preparation.service";

type Step = "welcome" | "language" | "microphone" | "accessibility" | "trigger" | "done";

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  language: "Spoken languages",
  microphone: "Microphone",
  accessibility: "Accessibility",
  trigger: "Trigger key",
  done: "Ready",
};

interface OnboardingPageProps {
  onComplete: () => void;
  startAtMic?: boolean;
}

export function OnboardingPage({ onComplete, startAtMic }: OnboardingPageProps) {
  const [step, setStep] = useState<Step>(startAtMic ? "microphone" : "welcome");
  const progressSteps: Step[] = ["welcome", "language", "microphone", "accessibility", "trigger"];
  progressSteps.push("done");

  return (
    <div className="onboarding-shell">
      {/* Drag region */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-[52px]" />

      <div className="setup-brand"><BrandMark /><span>Linty</span></div>
      <SoundPattern />
      <div className="onboarding-content">
        {step === "welcome" && <WelcomeStep onNext={() => setStep("language")} />}
        {step === "language" && <LanguageStep onNext={() => setStep("microphone")} />}
        {step === "microphone" && (
          <MicrophoneStep onNext={startAtMic ? onComplete : () => setStep("accessibility")} />
        )}
        {step === "accessibility" && (
          <AccessibilityStep onNext={() => setStep("trigger")} />
        )}
        {step === "trigger" && <TriggerStep onNext={() => setStep("done")} />}
        {step === "done" && <DoneStep onComplete={onComplete} onChangeLanguage={() => setStep("language")} />}

        <div className="onboarding-progress" aria-label="Setup progress">
          <p>{startAtMic ? "Restore microphone access" : `Step ${progressSteps.indexOf(step) + 1} of ${progressSteps.length} · ${STEP_LABELS[step]}`}</p>
          {!startAtMic && <ol>{progressSteps.map((item) => <li key={item} aria-current={item === step ? "step" : undefined}><span className="sr-only">{STEP_LABELS[item]}</span></li>)}</ol>}
        </div>
      </div>
    </div>
  );
}

/* ── Welcome Step ── */

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center animate-page-enter">
      <img src="/brand/icon.svg" alt="" width={80} height={80} className="mb-5" draggable={false} />

      <h1 className="text-[22px] font-bold text-text-primary mb-2">
        Welcome to Linty
      </h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        Voice-to-text for supported text fields on your Mac.
        <br />
        Choose the languages you speak most, then grant a couple of permissions.
        <br />
        Models download during setup. Linty also checks GitHub for app updates.
      </p>

      <LegalNotice />

      <button
        onClick={onNext}
        className={cn(
          "flex items-center gap-2 rounded-xl px-6 py-2.5 text-[14px] font-semibold",
          "bg-accent text-white",
          "hover:bg-accent-soft active:scale-[0.97]",
          "transition-interaction duration-150",
        )}
      >
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

/* ── Dictation Language Step ── */

function LanguageStep({ onNext }: { onNext: () => void }) {
  const { transcriptionLanguage, autoDetectLanguages, saveTranscriptionLanguage, saveAutoDetectLanguages } = useSettings();
  const [language, setLanguage] = useState(transcriptionLanguage);
  const [languages, setLanguages] = useState(() => autoDetectLanguages.length ? autoDetectLanguages
    : transcriptionLanguage === AUTO_LANGUAGE ? [] : [transcriptionLanguage]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);

  const continueSetup = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (language === AUTO_LANGUAGE) await saveAutoDetectLanguages(languages);
      await saveTranscriptionLanguage(language);
      onNext();
    } catch (error) {
      setError(`Could not save your spoken languages. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-center text-center animate-page-enter">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-info/15 mb-5">
        <Languages size={28} className="text-info" />
      </div>
      <h1 className="text-[22px] font-bold text-text-primary mb-2">
        Choose your dictation language
      </h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-6">
        Select the language you speak most, or choose Auto-detect.
        <br />
        You can change it anytime in Settings → Dictation.
      </p>
      <LanguagePicker label="Dictation language" value={language} disabled={saving}
        onChange={value => { setLanguage(value); setError(""); }} className="w-full max-w-[340px]" />
      {language === AUTO_LANGUAGE && <div className="mt-4 w-full max-w-[440px] text-left">
        <p className="text-[13px] text-text-secondary mb-3">Which languages do you speak most? Choose up to three. Auto-detect will try to identify the language of each recording using only these languages.</p>
        <FrequentLanguages value={languages} onChange={value => { setLanguages(value); setError(""); }} disabled={saving} />
      </div>}
      {language === "en" && <p className="text-[12px] text-text-secondary mt-4 max-w-[380px]">
        English includes on-device text cleanup. Linty prepares it automatically with a one-time download of about 496 MB.
      </p>}
      <p className="text-[12px] text-text-muted mt-3 mb-6">
        App menus stay in English.
      </p>
      {error && <p role="alert" className="text-[13px] text-error max-w-[380px] mb-4">{error}</p>}
      <button
        onClick={() => { void continueSetup(); }}
        disabled={saving || language === AUTO_LANGUAGE && !validAutoDetectLanguages(languages)}
        className={cn(
          "flex items-center gap-2 rounded-xl px-6 py-2.5 text-[14px] font-semibold",
          "bg-accent text-white hover:bg-accent-soft active:scale-[0.97]",
          "transition-interaction duration-150 disabled:opacity-50 disabled:cursor-wait",
        )}
      >
        {saving ? <>Saving…<Loader2 size={16} className="animate-spin" /></> : <>Continue<ArrowRight size={16} /></>}
      </button>
    </div>
  );
}

/* ── Microphone Step ── */

function MicrophoneStep({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<"checking" | "requesting" | "granted" | "denied">("checking");

  // Check status then always attempt a request — handles stale TCC entries
  // where authorizationStatus returns "denied" but no real entry exists.
  useEffect(() => {
    const init = async () => {
      const result = await checkMicrophonePermission().catch(() => "not_determined");
      if (result === "authorized") {
        setStatus("granted");
        return;
      }

      // Always try requesting — if truly denied, requestAccess returns false
      // immediately (no prompt). If TCC was cleared/stale, it may prompt.
      setStatus("requesting");
      const granted = await requestMicrophonePermission().catch(() => false);
      setStatus(granted ? "granted" : "denied");
    };
    init();
  }, []);

  // Auto-advance after grant
  useEffect(() => {
    if (status === "granted") {
      const timer = setTimeout(onNext, 800);
      return () => clearTimeout(timer);
    }
  }, [status, onNext]);

  // Poll for denied → granted (user may go to System Settings and toggle)
  useEffect(() => {
    if (status !== "denied") return;
    const interval = setInterval(async () => {
      const result = await checkMicrophonePermission().catch(() => "denied");
      if (result === "authorized") setStatus("granted");
    }, 2000);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <div className="flex flex-col items-center text-center animate-page-enter">
      <div className={cn(
        "flex h-16 w-16 items-center justify-center rounded-2xl mb-5 transition-colors duration-300",
        status === "granted" ? "bg-success/15" : "bg-info/15",
      )}>
        {status === "granted" ? (
          <CheckCircle2 size={28} className="text-success" />
        ) : (
          <Mic size={28} className="text-info" />
        )}
      </div>

      <h1 className="text-[22px] font-bold text-text-primary mb-2">
        Microphone Access
      </h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        Linty needs your microphone to capture speech for transcription.
      </p>

      {(status === "checking" || status === "requesting") && (
        <div className="flex items-center gap-2.5 text-[13px] text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          {status === "checking" ? "Checking permission..." : "Waiting for your response..."}
        </div>
      )}

      {status === "granted" && (
        <div className="flex items-center gap-2 text-[14px] font-medium text-success">
          <CheckCircle2 size={18} />
          Microphone access granted
        </div>
      )}

      {status === "denied" && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-[13px] text-warning">
            Microphone access was denied. Open System Settings, find Linty in the Microphone list, and toggle it off then back on.
          </p>
          <button
            onClick={() => openSystemSettings("microphone")}
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-5 py-2 text-[13px] font-medium",
              "bg-accent text-white",
              "hover:bg-accent-soft active:scale-[0.97]",
              "transition-interaction duration-150",
            )}
          >
            Open System Settings
            <ExternalLink size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Accessibility Step ── */

function AccessibilityStep({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<"checking" | "prompting" | "granted" | "waiting">("checking");
  const [showDevHint, setShowDevHint] = useState(false);

  // Show dev hint after 30s of waiting
  useEffect(() => {
    if (status !== "waiting") return;
    const timer = setTimeout(() => setShowDevHint(true), 30_000);
    return () => clearTimeout(timer);
  }, [status]);

  const checkStatus = useCallback(async () => {
    const granted = await checkAccessibility().catch(() => false);
    if (granted) {
      setStatus("granted");
    } else {
      setStatus("prompting");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Prompt for accessibility
  useEffect(() => {
    if (status !== "prompting") return;

    const doPrompt = async () => {
      const granted = await requestAccessibility().catch(() => false);
      setStatus(granted ? "granted" : "waiting");
    };
    doPrompt();
  }, [status]);

  // Auto-advance + reinit fn key monitor after grant
  useEffect(() => {
    if (status === "granted") {
      // Reinit the fn key monitor now that accessibility is granted
      reinitFnKeyMonitor().catch(console.error);
      const timer = setTimeout(onNext, 800);
      return () => clearTimeout(timer);
    }
  }, [status, onNext]);

  // Poll for granted (user toggling in System Settings)
  useEffect(() => {
    if (status !== "waiting") return;
    const interval = setInterval(async () => {
      const granted = await checkAccessibility().catch(() => false);
      if (granted) setStatus("granted");
    }, 1500);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <div className="flex flex-col items-center text-center animate-page-enter">
      <div className={cn(
        "flex h-16 w-16 items-center justify-center rounded-2xl mb-5 transition-colors duration-300",
        status === "granted" ? "bg-success/15" : "bg-info/15",
      )}>
        {status === "granted" ? (
          <CheckCircle2 size={28} className="text-success" />
        ) : (
          <Shield size={28} className="text-info" />
        )}
      </div>

      <h1 className="text-[22px] font-bold text-text-primary mb-2">
        Accessibility Permission
      </h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        Required for the fn key push-to-talk shortcut and auto-pasting transcriptions.
      </p>

      {status === "checking" && (
        <div className="flex items-center gap-2.5 text-[13px] text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          Checking permission...
        </div>
      )}

      {status === "granted" && (
        <div className="flex items-center gap-2 text-[14px] font-medium text-success">
          <CheckCircle2 size={18} />
          Accessibility granted
        </div>
      )}

      {(status === "prompting" || status === "waiting") && (
        <div className="flex flex-col items-center gap-4">
          {status === "waiting" && (
            <div className="rounded-xl border border-border-subtle bg-bg-secondary px-4 py-3 text-left max-w-[340px]">
              <p className="text-[12px] text-text-secondary leading-relaxed">
                <span className="font-medium text-text-primary">System Settings</span> should have opened.
                Find <span className="font-medium text-text-primary">Linty</span> in the Accessibility list and toggle it on.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2.5 text-[13px] text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Waiting for you to enable accessibility...
          </div>

          <button
            onClick={() =>
              openSystemSettings("accessibility")
            }
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-5 py-2 text-[13px] font-medium",
              "bg-bg-elevated border border-border text-text-secondary",
              "hover:bg-bg-hover hover:text-text-primary active:scale-[0.97]",
              "transition-interaction duration-150",
            )}
          >
            Open System Settings
            <ExternalLink size={13} />
          </button>

          {showDevHint && (
            <div className="rounded-xl border border-warning/20 bg-warning/5 px-4 py-3 text-left max-w-[340px]">
              <p className="text-[12px] text-text-secondary leading-relaxed">
                <span className="font-medium text-warning">Still waiting?</span>{" "}
                Remove Linty from the Accessibility list, then add it again from Applications and enable access.
              </p>
            </div>
          )}

          <button
            onClick={onNext}
            className="text-[12px] text-text-muted hover:text-text-secondary transition-colors duration-150"
          >
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Trigger Key Step ── */

function TriggerStep({ onNext }: { onNext: () => void }) {
  const { triggerKey, saveTriggerKey } = useSettings();

  return (
    <div className="flex flex-col items-center text-center animate-page-enter">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-info/15 mb-5">
        <Keyboard size={28} className="text-info" />
      </div>

      <h1 className="text-[22px] font-bold text-text-primary mb-2">
        Choose Your Trigger Key
      </h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-6">
        Hold to talk and release to paste. Or double-press to keep listening, then press once to finish.
        <br />
        You can change it anytime from the Shortcuts page.
      </p>

      <TriggerKeyPicker
        value={triggerKey}
        onChange={saveTriggerKey}
        className="mb-6 w-full max-w-[420px]"
      />

      <button
        onClick={onNext}
        className={cn(
          "flex items-center gap-2 rounded-xl px-6 py-2.5 text-[14px] font-semibold",
          "bg-accent text-white",
          "hover:bg-accent-soft active:scale-[0.97]",
          "transition-interaction duration-150",
        )}
      >
        Continue
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

/* ── Done Step ── */

function DoneStep({ onComplete, onChangeLanguage }: { onComplete: () => void; onChangeLanguage: () => void }) {
  const { triggerKey } = useAppStore();
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);
  const triggerLabel = formatTriggerLabel(triggerKey);
  const ready = preparation.status === "ready";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  return <div className="flex flex-col items-center text-center animate-page-enter">
    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/15 mb-5">
      {ready ? <CheckCircle2 size={28} className="text-success" /> : <Languages size={28} className="text-accent" />}
    </div>
    <h1 className="text-[22px] font-bold text-text-primary mb-2">{ready ? "You're All Set" : "Getting your language ready"}</h1>
    <p className="text-[14px] text-text-secondary leading-relaxed mb-6">
      Hold <span className="font-medium text-text-primary">{triggerLabel}</span> anywhere to start recording.<br />Release to transcribe and auto-paste.
    </p>
    <div className="w-full mb-5"><LanguageReadiness /></div>
    <FnKeyConflictWarning className="mb-6 max-w-[400px]" />
    {error && <p role="alert" className="text-error text-[13px] mb-3">{error}</p>}
    <button disabled={!ready || saving} onClick={async () => {
      setSaving(true); setError("");
      try { await onComplete(); } catch { setError("Could not finish setup. Please try again."); }
      finally { setSaving(false); }
    }} className="standard-button primary-button">
      {saving ? "Saving…" : "Start Using Linty"}{saving ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
    </button>
    <div className="flex flex-wrap justify-center gap-5 mt-5">
      <button className="text-link text-[12px]" disabled={saving} onClick={onChangeLanguage}>Change language</button>
    </div>
  </div>;
}
