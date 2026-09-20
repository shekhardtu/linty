import { useState, useEffect, useCallback } from "react";
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
  reinitFnKeyMonitor,
  openSystemSettings,
} from "@/services/permissions.service";
import { MicrophoneTest } from "@/components/MicrophoneTest.component";
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
    // Stop polling once both permissions are granted
    if (permissions.microphone === "authorized" && permissions.accessibility) {
      return;
    }
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [poll, permissions.microphone, permissions.accessibility]);

  // Reinit fn key monitor when accessibility becomes granted
  useEffect(() => {
    if (permissions.accessibility) {
      reinitFnKeyMonitor().catch(console.error);
    }
  }, [permissions.accessibility]);

  const requestMic = async () => {
    await requestMicrophonePermission();
    poll();
  };

  return { permissions, requestMic };
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
        status === "not_asked" && "bg-warning-glow text-warning",
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
  const { permissions, requestMic } = usePermissions();

  const micStatus: "granted" | "denied" | "not_asked" =
    permissions.microphone === "authorized"
      ? "granted"
      : permissions.microphone === "denied" ||
          permissions.microphone === "restricted"
        ? "denied"
        : "not_asked";

  const axStatus: "granted" | "denied" | "not_asked" = permissions.accessibility
    ? "granted"
    : "denied";
  const permissionsReady = micStatus === "granted" && axStatus === "granted";

  return (
    <PageLayout reading>
      <PageHeader page="system-check" />
      <div className={cn("system-readiness", permissionsReady && "is-ready")}>
        {permissionsReady ? <CheckCircle2 /> : <AlertCircle />}
        <div>
          <h2>
            {permissionsReady ? "All set to listen." : "Let’s get you ready."}
          </h2>
          <p>
            {permissionsReady
              ? "Required permissions are granted. Try your microphone below."
              : "Review the permissions below to start dictating."}
          </p>
        </div>
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
          description="Required for auto-paste & fn key monitoring"
          status={axStatus}
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

      <MicrophoneTest />
    </PageLayout>
  );
}
