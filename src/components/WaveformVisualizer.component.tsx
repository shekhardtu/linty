import { useCallback, useEffect, useRef } from "react";
import { advanceWaveform, drawWaveform, WAVEFORM_BAR_COUNT } from "@/lib/dictation-waveform";
import type { LevelCanvas } from "@/lib/dictation-waveform";
import { useInputLevel } from "@/hooks/useInputLevel.hook";
import { cn } from "@/lib/utils";

interface WaveformVisualizerProps {
  isActive: boolean;
  className?: string;
  barCount?: number;
  fillWidth?: boolean;
}

/**
 * Live input waveform, drawn on a canvas. Per-frame DOM style writes (and CSS
 * transitions on them) retain memory in WebKit for as long as the page lives;
 * canvas drawing does not (#154, #156).
 */
export function WaveformVisualizer({ isActive, className, barCount = WAVEFORM_BAR_COUNT, fillWidth = false }: WaveformVisualizerProps) {
  const canvasRef = useRef<LevelCanvas | null>(null);
  const levelsRef = useRef<number[]>(Array<number>(barCount).fill(0));

  const paint = useCallback(() => {
    if (canvasRef.current) drawWaveform(canvasRef.current, levelsRef.current, { fill: fillWidth, idle: !isActive });
  }, [fillWidth, isActive]);

  const attach = useCallback((element: LevelCanvas | null) => {
    canvasRef.current = element;
    if (element) paint();
  }, [paint]);

  useEffect(() => {
    levelsRef.current = Array<number>(barCount).fill(0);
    paint();
  }, [isActive, barCount, paint]);

  // Every polled frame advances the history, including repeated zeroes, so old
  // speech never stays visible during silence.
  useInputLevel(isActive, rms => {
    levelsRef.current = advanceWaveform(levelsRef.current, rms);
    paint();
  });

  return (
    <canvas
      ref={attach}
      className={cn("waveform-canvas", !isActive && "is-idle", className)}
      aria-hidden="true"
    />
  );
}
