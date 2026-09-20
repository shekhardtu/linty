import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";

interface RecordingIndicatorProps {
  isRecording: boolean;
  duration: number;
  className?: string;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  if (mins > 0) {
    return `${mins}:${secs.toString().padStart(2, "0")}.${tenths}`;
  }
  return `${secs}.${tenths}s`;
}

export function RecordingIndicator({
  isRecording,
  duration,
  className,
}: RecordingIndicatorProps) {
  return (
    <div className={cn("flex flex-col items-center gap-2.5", className)}>
      <div className="relative flex items-center justify-center">
        {isRecording && (
          <>
            <div
              className="animate-pulse-ring-slow absolute rounded-full"
              style={{
                width: 56,
                height: 56,
                border: "1px solid var(--color-accent)",
                opacity: 0.12,
              }}
            />
            <div
              className="animate-pulse-ring absolute rounded-full"
              style={{
                width: 56,
                height: 56,
                border: "1.5px solid var(--color-accent)",
                opacity: 0.2,
              }}
            />
            <div
              className="animate-breathe absolute rounded-full"
              style={{
                width: 48,
                height: 48,
                background:
                  "radial-gradient(circle, var(--color-accent-glow-strong) 0%, transparent 70%)",
              }}
            />
          </>
        )}

        <div
          className={cn(
            "relative z-10 flex items-center justify-center rounded-full transition-interaction duration-200",
            isRecording
              ? "h-10 w-10 bg-accent shadow-[0_0_16px_var(--color-accent-glow-strong)]"
              : "h-10 w-10 bg-bg-elevated border border-border",
          )}
        >
          <Mic
            size={isRecording ? 18 : 16}
            strokeWidth={1.8}
            className={cn(
              "transition-colors duration-200",
              isRecording ? "text-white" : "text-text-muted",
            )}
          />
        </div>
      </div>

      {isRecording && (
        <div className="animate-fade-in flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 rounded-full bg-accent animate-breathe" />
          <span className="text-[13px] font-medium text-text-secondary tabular-nums">
            {formatDuration(duration)}
          </span>
        </div>
      )}
    </div>
  );
}
