import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink } from "lucide-react";
import {
  checkFnKeyConflict,
  openSystemSettings,
  type FnKeyConflict,
} from "@/services/permissions.service";
import { useAppStore } from "@/store/app.store";
import { TRIGGER_KEY_FN } from "@/store/slices/settings.slice";
import { cn } from "@/lib/utils";

const FN_USAGE_LABELS: Record<number, string> = {
  1: "Change Input Source",
  2: "Show Emoji & Symbols",
  3: "Start Dictation",
};

/**
 * Warns when macOS also handles the fn key (AppleFnUsageType != 0).
 * Linty's NSEvent monitors are observe-only, so a system binding fires
 * alongside push-to-talk — Apple Dictation then pastes the same speech
 * twice (issue #32). Polls while mounted so the warning clears as soon
 * as the user sets "Press 🌐 key to" to "Do Nothing". Renders nothing
 * when the configured trigger is not the fn key — the conflict is
 * irrelevant then.
 */
export function FnKeyConflictWarning({ className }: { className?: string }) {
  const triggerKey = useAppStore((s) => s.triggerKey);
  const [conflict, setConflict] = useState<FnKeyConflict | null>(null);

  const isFnTrigger = triggerKey === TRIGGER_KEY_FN;

  useEffect(() => {
    if (!isFnTrigger) return;

    const poll = async () => {
      const result = await checkFnKeyConflict().catch(() => null);
      setConflict(result);
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [isFnTrigger]);

  if (!isFnTrigger || !conflict?.conflict) return null;

  const action =
    conflict.usage_type !== null
      ? FN_USAGE_LABELS[conflict.usage_type] ?? "a system action"
      : "its default action (Emoji & Symbols or Dictation)";

  return (
    <div
      className={cn(
        "rounded-xl border border-warning/20 bg-warning/5 px-4 py-3.5 text-left",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertCircle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-warning">
            macOS is also using the fn key
          </span>
          <p className="text-[12px] text-text-secondary leading-relaxed">
            fn also triggers{" "}
            <span className="font-medium text-text-primary">{action}</span>{" "}
            in macOS. Set{" "}
            <span className="font-medium text-text-primary">
              "Press 🌐 key to"
            </span>{" "}
            to <span className="font-medium text-text-primary">"Do Nothing"</span>{" "}
            in Keyboard settings.
          </p>
          <button
            onClick={() => openSystemSettings("keyboard")}
            className={cn(
              "mt-1 flex w-fit items-center gap-1.5 rounded-lg px-3 py-[5px] text-[12px] font-medium",
              "bg-bg-elevated border border-border text-text-secondary",
              "hover:bg-bg-hover hover:text-text-primary active:scale-[0.97]",
              "transition-interaction duration-150",
            )}
          >
            Open Keyboard Settings
            <ExternalLink size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
