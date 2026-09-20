import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16 px-8",
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-elevated text-text-muted opacity-60">
        {icon}
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h3 className="text-[13px] font-medium text-text-secondary">
          {title}
        </h3>
        <p className="max-w-[240px] text-[13px] leading-relaxed text-text-muted">
          {description}
        </p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
