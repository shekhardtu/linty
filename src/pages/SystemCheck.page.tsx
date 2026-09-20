import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import {
  Mic,
  Accessibility,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import {
  checkMicrophonePermission,
  requestMicrophonePermission,
  checkAccessibility,
  requestAccessibility,
  reinitFnKeyMonitor,
  openSystemSettings,
} from "@/services/permissions.service";
import { MicrophoneTest } from "@/components/MicrophoneTest.component";
import { LegalNotice } from "@/components/shared/LegalNotice.component";
import { LanguageReadiness } from "@/components/settings/LanguageReadiness.component";
import { languagePreparation } from "@/services/language-preparation.service";
import { AUTO_LANGUAGE, languageLabel, validAutoDetectLanguages } from "@/lib/languages.util";
import { formatTriggerLabel } from "@/lib/trigger.util";
import { useAppStore } from "@/store/app.store";
import { FnKeyConflictWarning } from "@/components/shared/FnKeyConflictWarning.component";
import { cn } from "@/lib/utils";
import {
  PageLayout,
  PageHeader,
} from "@/components/shared/PageLayout.component";

type PermissionStatus =
  "authorized" | "denied" | "not_determined" | "restricted";

interface PermissionState {
  microphone: PermissionStatus;
  accessibility: boolean;
}

function usePermissions() {
  const [permissions, setPermissions] = useState<PermissionState>({
    microphone: "not_determined",
    accessibility: false,
  });

  const poll = useCallback(async () => {
    const [mic, ax] = await Promise.all([
      checkMicrophonePermission().catch(() => "not_determined"),
      checkAccessibility().catch(() => false),
    ]);
    setPermissions({
      microphone: mic as PermissionStatus,
      accessibility: ax,
    });
  }, []);

  useEffect(() => {
    poll();
    window.addEventListener("focus", poll);
    // Stop polling once both permissions are granted
    if (permissions.microphone === "authorized" && permissions.accessibility) {
      return () => window.removeEventListener("focus", poll);
    }
    const interval = setInterval(poll, 3000);
    return () => { clearInterval(interval); window.removeEventListener("focus", poll); };
  }, [poll, permissions.microphone, permissions.accessibility]);

  // Reinit fn key monitor when accessibility becomes granted
  useEffect(() => {
    if (permissions.accessibility) {
      reinitFnKeyMonitor().catch(console.error);
    }
  }, [permissions.accessibility]);

  const requestMic = async () => {
    try {
      await requestMicrophonePermission();
      await poll();
    } catch {
      useAppStore.getState().addToast({ type: "error", message: "Could not request microphone access. Open Microphone in System Settings to enable Linty." });
    }
  };

  const requestAx = async () => {
    try {
      if (!await requestAccessibility()) await openSystemSettings("accessibility");
      await poll();
    } catch {
      useAppStore.getState().addToast({ type: "error", message: "Could not open Accessibility settings. Open System Settings → Privacy & Security → Accessibility and enable Linty." });
    }
  };

  return { permissions, requestMic, requestAx };
}

function StatusBadge({
  status,
}: {
  status: "granted" | "denied" | "not_asked";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
        status === "granted" && "bg-success-glow text-success",
        status === "denied" && "bg-error-glow text-error",
        status === "not_asked" && "bg-warning-glow text-text-primary",
      )}
    >
      {status === "granted" && (
        <>
          <CheckCircle2 size={11} />
          Granted
        </>
      )}
      {status === "denied" && (
        <>
          <AlertCircle size={11} />
          Denied
        </>
      )}
      {status === "not_asked" && (
        <>
          <AlertCircle size={11} />
          Not Granted
        </>
      )}
    </span>
  );
}
function PermissionRow({
  icon,
  label,
  description,
  status,
  onGrant,
  onOpenSettings,
  isLast,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  status: "granted" | "denied" | "not_asked";
  onGrant?: () => void;
  onOpenSettings?: () => void;
  isLast?: boolean;
}) {
  return (
    <div
      className={cn(
        "permission-row flex items-center gap-3.5 px-4 py-3.5",
        !isLast && "border-b border-border-subtle",
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-elevated">
        {icon}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-medium text-text-primary">
          {label}
        </span>
        <span className="text-[11px] text-text-muted">{description}</span>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <StatusBadge status={status} />

        {status === "not_asked" && onGrant && (
          <button
            onClick={onGrant}
            className={cn(
              "rounded-lg px-3 py-[5px] text-[12px] font-medium",
              "bg-accent text-white",
              "hover:bg-accent-soft active:scale-[0.97]",
              "transition-interaction duration-150",
            )}
          >
            Grant
          </button>
        )}

        {(status === "denied" || status === "granted") && onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className={cn(
              "flex items-center gap-1 rounded-lg px-3 py-[5px] text-[12px] font-medium",
              "bg-bg-elevated border border-border text-text-secondary",
              "hover:bg-bg-hover hover:text-text-primary active:scale-[0.97]",
              "transition-interaction duration-150",
            )}
          >
            Open Settings
            <ExternalLink size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

export function SystemCheckPage() {
  const { permissions, requestMic, requestAx } = usePermissions();
  const { transcriptionLanguage, autoDetectLanguages, triggerKey } = useAppStore();
  const preparation = useSyncExternalStore(languagePreparation.subscribe, languagePreparation.getSnapshot);

  const micStatus: "granted" | "denied" | "not_asked" =
    permissions.microphone === "authorized"
      ? "granted"
      : permissions.microphone === "denied" ||
          permissions.microphone === "restricted"
        ? "denied"
        : "not_asked";

  const axStatus: "granted" | "denied" | "not_asked" = permissions.accessibility
    ? "granted"
    : "not_asked";
  const permissionsReady = micStatus === "granted" && axStatus === "granted";
  const needsLanguages = transcriptionLanguage === AUTO_LANGUAGE && !validAutoDetectLanguages(autoDetectLanguages);
  const failed = preparation.status === "error" || preparation.status === "unavailable";
  const speechReady = preparation.status === "ready" && !needsLanguages;
  const ready = permissionsReady && speechReady;

  return (
    <PageLayout reading>
      <PageHeader page="system-check" />
      <div className={cn("system-readiness", ready && "is-ready")}>
        {ready ? <CheckCircle2 /> : <AlertCircle />}
        <div>
          <h2>
            {ready ? "All set to listen." : !permissionsReady ? "Allow access. Then start talking."
              : failed ? "Speech support needs attention." : needsLanguages ? "Choose your spoken languages." : "Getting your language ready."}
          </h2>
          <p>
            {ready
              ? <>Open a text field, hold <kbd>{formatTriggerLabel(triggerKey)}</kbd>, speak, and release to paste.</>
              : !permissionsReady ? "macOS needs your permission to hear your voice and insert text into other apps."
              : failed ? "Review the preparation details below to get dictation ready."
              : needsLanguages ? "Select one to three languages in Settings → Dictation for Auto-detect."
              : "Your permissions are ready. Linty is preparing dictation automatically."}
          </p>
        </div>
      </div>

      <div className="mb-6 text-[13px] text-text-secondary">
        <p><strong className="text-text-primary">{languageLabel(transcriptionLanguage)}</strong> · Hold <kbd>{formatTriggerLabel(triggerKey)}</kbd> to dictate.</p>
      </div>

      {/* Section label */}
      <div className="mb-2.5">
        <span className="text-[13px] font-semibold text-text-primary">
          Permissions
        </span>
      </div>

      {/* Permission cards */}
      <div className="settings-group">
        <PermissionRow
          icon={<Mic size={15} className="text-text-secondary" />}
          label="Microphone Access"
          description="Required for voice recording"
          status={micStatus}
          onGrant={requestMic}
          onOpenSettings={() => openSystemSettings("microphone")}
        />
        <PermissionRow
          icon={<Accessibility size={15} className="text-text-secondary" />}
          label="Accessibility"
          description="Required for shortcuts and automatic paste"
          status={axStatus}
          onGrant={requestAx}
          onOpenSettings={() => openSystemSettings("accessibility")}
          isLast
        />
      </div>

      <FnKeyConflictWarning className="mt-3" />

      {/* Footer note */}
      <p className="mt-3 text-[11px] text-text-muted">
        Permission status updates automatically when you return from System
        Settings.
      </p>

      <div className="mt-5"><LanguageReadiness compact /></div>
      <LegalNotice compact />
      {micStatus === "granted" && speechReady && <MicrophoneTest />}
    </PageLayout>
  );
}
