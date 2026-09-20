import { useId } from "react";
import { cn } from "@/lib/utils";

interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({
  enabled,
  onChange,
  label,
  description,
  disabled,
}: ToggleProps) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      onClick={() => !disabled && onChange(!enabled)}
      disabled={disabled}
      className={cn(
        "setting-toggle flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-150",
        "hover:bg-bg-hover",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="field-label truncate">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="text-[12px] text-text-secondary leading-snug">
            {description}
          </span>
        )}
      </div>
      <div
        className={cn(
          "relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-200",
          enabled ? "bg-accent" : "bg-border",
        )}
      >
        <div
          className={cn(
            "toggle-thumb absolute left-[2px] top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-sm",
          )}
          style={{ transform: `translateX(${enabled ? 14 : 0}px)` }}
        />
      </div>
    </button>
  );
}
