import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { advanceWaveform, WAVEFORM_BAR_COUNT } from "@/lib/dictation-waveform";
import { cn } from "@/lib/utils";

interface WaveformVisualizerProps {
  isActive: boolean;
  className?: string;
  barCount?: number;
  fillWidth?: boolean;
}

export function WaveformVisualizer({ isActive, className, barCount = WAVEFORM_BAR_COUNT, fillWidth = false }: WaveformVisualizerProps) {
  const [levels, setLevels] = useState(() => Array<number>(barCount).fill(0));

  useEffect(() => {
    setLevels(Array<number>(barCount).fill(0));
    if (!isActive) return;
    let disposed = false;
    // Consume every native frame, including repeated zeroes. A single amplitude
    // prop can skip identical values and leave old speech visible during silence.
    const unlisten = listen<number>("audio-amplitude", ({ payload }) => {
      if (!disposed) setLevels(previous => advanceWaveform(previous, payload));
    });
    return () => {
      disposed = true;
      void unlisten.then(off => off());
    };
  }, [isActive, barCount]);

  return (
    <div className={cn("flex items-center justify-center gap-[2px]", className)} aria-hidden="true">
      {levels.map((level, i) => (
        <div
          key={i}
          className={cn("waveform-bar h-full rounded-full", fillWidth ? "flex-1 min-w-0" : "w-[2px] shrink-0")}
          style={{
            background: isActive ? "var(--color-accent)" : "var(--color-border)",
            transform: `scaleY(${0.1 + level * 0.9})`,
            opacity: isActive ? 0.4 + level * 0.6 : 0.2,
          }}
        />
      ))}
    </div>
  );
}
