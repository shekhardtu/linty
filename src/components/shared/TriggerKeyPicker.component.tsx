import { useEffect, useState } from "react";
import { Check, Keyboard } from "lucide-react";
import {
  TRIGGER_KEY_OPTIONS,
  MODIFIER_TRIGGER_PREFIX,
} from "@/store/slices/settings.slice";
import {
  MODIFIER_CAPTURE_CODES,
  COMMON_SHORTCUT_USAGE,
  codeToAcceleratorKey,
  formatTriggerDisplay,
  formatTriggerLabel,
} from "@/lib/trigger.util";
import { FnKeyConflictWarning } from "@/components/shared/FnKeyConflictWarning.component";
import { cn } from "@/lib/utils";

interface TriggerKeyPickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  allowCustom?: boolean;
  compact?: boolean;
}

/**
 * Push-to-talk trigger selection: quick presets plus free-form capture.
 * Capture accepts a bare modifier hold (right ⌘, left ⌥, ...) or any
 * key combination the global-shortcut plugin can register. The fn key
 * produces no DOM key events, so it stays a listed preset only.
 */
export function TriggerKeyPicker({ value, onChange, className, allowCustom = true, compact = false }: TriggerKeyPickerProps) {
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState("");
  // A captured combo that collides with a universal shortcut (⌘C, ⌘V, ...) —
  // held here until the user explicitly confirms or cancels
  const [pendingCombo, setPendingCombo] = useState<{ accelerator: string; usage: string } | null>(null);

  const isPreset = TRIGGER_KEY_OPTIONS.some((o) => o.value === value);

  const select = (selected: string) => {
    setPendingCombo(null);
    setCaptureError("");
    onChange(selected);
  };

  useEffect(() => {
    if (!capturing) return;

    let lastModifierCode: string | null = null;

    const finish = (selected: string) => {
      setCapturing(false);
      setCaptureError("");
      onChange(selected);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === "Escape") {
        setCapturing(false);
        setCaptureError("");
        return;
      }

      if (MODIFIER_CAPTURE_CODES[e.code]) {
        lastModifierCode = e.code;
        return;
      }

      const keyToken = codeToAcceleratorKey(e.code);
      if (!keyToken) {
        setCaptureError("That key can't be used as a global shortcut.");
        return;
      }

      const mods = [
        e.metaKey && "Command",
        e.ctrlKey && "Control",
        e.altKey && "Alt",
        e.shiftKey && "Shift",
      ].filter(Boolean) as string[];

      // A bare letter/number would hijack normal typing system-wide
      if (mods.length === 0 && !/^F\d+$/.test(keyToken)) {
        setCaptureError("Add a modifier (⌘ ⌃ ⌥) or use an F-key.");
        return;
      }

      const accelerator = [...mods, keyToken].join("+");
      const usage = COMMON_SHORTCUT_USAGE[accelerator];
      if (usage) {
        // Universal shortcut — require explicit confirmation before hijacking it
        setCapturing(false);
        setCaptureError("");
        setPendingCombo({ accelerator, usage });
        return;
      }

      finish(accelerator);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // Releasing a lone modifier (no combo formed, no other modifier still
      // held) selects it as a hold-to-talk trigger
      if (
        MODIFIER_CAPTURE_CODES[e.code] &&
        lastModifierCode === e.code &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        finish(MODIFIER_TRIGGER_PREFIX + MODIFIER_CAPTURE_CODES[e.code]);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing, onChange]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="settings-group">
        {TRIGGER_KEY_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              aria-pressed={selected}
              onClick={() => select(option.value)}
              className={cn(
                "flex w-full items-center gap-3 border-b border-border-subtle px-4 py-3 text-left transition-colors duration-150",
                selected ? "bg-bg-active" : "hover:bg-bg-hover",
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-text-primary">
                  {option.label}
                </span>
                {!compact && <span className="text-[12px] text-text-secondary">
                  {option.description}
                </span>}
              </div>
              <kbd className="shrink-0 rounded-md bg-bg-hover border border-border-subtle px-2.5 py-1 text-[12px] font-medium text-text-secondary tabular-nums">
                {option.display}
              </kbd>
              <div className="w-4 shrink-0">
                {selected && <Check size={14} className="text-accent" />}
              </div>
            </button>
          );
        })}

        {/* Current custom trigger (captured, no matching preset) */}
        {!isPreset && (
          <div className="flex w-full items-center gap-3 border-b border-border-subtle bg-bg-active px-4 py-3 text-left">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-text-primary">
                Custom
              </span>
              {!compact && <span className="text-[12px] text-text-secondary">
                Your recorded trigger.
              </span>}
            </div>
            <kbd className="shrink-0 rounded-md bg-bg-hover border border-border-subtle px-2.5 py-1 text-[12px] font-medium text-text-secondary tabular-nums">
              {formatTriggerDisplay(value)}
            </kbd>
            <div className="w-4 shrink-0">
              <Check size={14} className="text-accent" />
            </div>
          </div>
        )}

        {/* Free-form capture */}
        {allowCustom && <button
          onClick={() => {
            setCaptureError("");
            setPendingCombo(null);
            setCapturing(true);
          }}
          className={cn(
            "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150",
            capturing ? "bg-bg-active" : "hover:bg-bg-hover",
          )}
        >
          <Keyboard size={15} className="shrink-0 text-text-secondary" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-text-primary">
              {capturing ? "Press your key or combination…" : "Record a custom trigger"}
            </span>
            <span className="text-[12px] text-text-secondary">
              {capturing
                ? "Hold a single modifier and release it, or press a combo. Esc cancels."
                : "Any modifier key alone, or any combination."}
            </span>
          </div>
        </button>}
      </div>

      {captureError && (
        <p role="alert" className="text-[12px] text-error">{captureError}</p>
      )}

      {pendingCombo && (
        <div className="rounded-xl border border-warning/20 bg-warning/5 px-4 py-3 text-left">
          <p className="text-[12px] text-text-secondary leading-relaxed">
            <span className="font-medium text-text-primary">
              {formatTriggerLabel(pendingCombo.accelerator)}
            </span>{" "}
            is <span className="font-medium text-warning">{pendingCombo.usage}</span> in
            most apps. Using it as the trigger overrides it system-wide.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => select(pendingCombo.accelerator)}
              className={cn(
                "rounded-lg px-3 py-[5px] text-[12px] font-medium",
                "bg-bg-elevated border border-border text-text-secondary",
                "hover:bg-bg-hover hover:text-text-primary active:scale-[0.97]",
                "transition-interaction duration-150",
              )}
            >
              Use it anyway
            </button>
            <button
              onClick={() => setPendingCombo(null)}
              className="text-[12px] text-text-muted hover:text-text-secondary transition-colors duration-150"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <FnKeyConflictWarning />
    </div>
  );
}
