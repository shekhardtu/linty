import { cn } from "@/lib/utils";

interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  pending?: boolean;
}

interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  label?: string;
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  className,
  label = "Options",
}: SegmentedControlProps<T>) {
  const enabled = segments.filter((segment) => !segment.disabled);
  const tabStop = enabled.find((segment) => segment.value === value)?.value ?? enabled[0]?.value;
  return (
    <div role="group" aria-label={label}
      className={cn(
        "segmented-control",
        className,
      )}
    >
      {segments.map((segment) => {
        const isActive = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            aria-pressed={isActive}
            data-pending={isActive && segment.pending ? "true" : undefined}
            disabled={segment.disabled}
            tabIndex={segment.value === tabStop ? 0 : -1}
            onKeyDown={(e) => {
              if (!enabled.length) return;
              const index = enabled.findIndex((item) => item.value === segment.value);
              let next = index;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % enabled.length;
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + enabled.length) % enabled.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = enabled.length - 1;
              else return;
              e.preventDefault();
              onChange(enabled[next].value);
              (e.currentTarget.parentElement?.children[segments.indexOf(enabled[next])] as HTMLButtonElement)?.focus();
            }}
            onClick={(e) => { e.currentTarget.focus(); onChange(segment.value); }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-[5px] text-[12px] font-medium transition-interaction duration-200 disabled:opacity-50 disabled:cursor-not-allowed",
              isActive
                ? "bg-bg-elevated border border-border text-text-primary shadow-sm"
                : "border border-transparent text-text-secondary hover:text-text-primary",
            )}
          >
            {segment.icon && (
              <span className={cn(isActive ? "text-accent" : "text-text-muted")}>
                {segment.icon}
              </span>
            )}
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
