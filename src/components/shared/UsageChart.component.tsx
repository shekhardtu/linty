import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { usageTimeline } from "@/lib/usage.util";
import { FloatingTooltip } from "./FloatingTooltip.component";

const number = (value: number) => value.toLocaleString();
export function UsageChart({
  timeline,
  hasHistory,
}: {
  timeline: ReturnType<typeof usageTimeline>;
  hasHistory: boolean;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [active, setActive] = useState<{
    index: number;
    anchor: { x: number; y: number };
    source: "pointer" | "keyboard";
  } | null>(null);
  useEffect(() => {
    const repositionOrDismiss = () =>
      setActive((current) => {
        const focused = document.activeElement;
        if (
          current?.source === "keyboard" &&
          focused &&
          chartRef.current?.contains(focused)
        ) {
          const rect = focused.getBoundingClientRect();
          return {
            ...current,
            anchor: { x: rect.left + rect.width / 2, y: rect.top },
          };
        }
        return null;
      });
    window.addEventListener("scroll", repositionOrDismiss, true);
    window.addEventListener("resize", repositionOrDismiss);
    return () => {
      window.removeEventListener("scroll", repositionOrDismiss, true);
      window.removeEventListener("resize", repositionOrDismiss);
    };
  }, []);
  useEffect(() => setActive(null), [timeline]);
  const maxWords = Math.max(1, ...timeline.map((day) => day.words));
  const hasWords = timeline.some((day) => day.words > 0);
  const columns = Math.max(1, timeline.length);
  const labelCount = Math.min(timeline.length, timeline.length <= 8 ? 8 : 5);
  const labelIndices = new Set(
    Array.from({ length: labelCount }, (_, i) =>
      Math.round((i * (timeline.length - 1)) / Math.max(1, labelCount - 1)),
    ),
  );
  const activeDay = active ? timeline[active.index] : undefined;
  return (
    <div
      ref={chartRef}
      className="usage-chart"
      style={
        {
          "--chart-columns": columns,
          // Leave room for the bars even when all-time spans many months.
          gap: `min(${timeline.length > 14 ? 3 : 8}px, ${30 / columns}%)`,
        } as CSSProperties
      }
      role="group"
      aria-label="Words transcribed over time"
      onPointerMove={(event) => {
        if (event.pointerType === "touch" || !timeline.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const index = Math.max(
          0,
          Math.min(
            timeline.length - 1,
            Math.floor(
              ((event.clientX - rect.left) / rect.width) * timeline.length,
            ),
          ),
        );
        setActive({
          index,
          anchor: { x: event.clientX, y: event.clientY },
          source: "pointer",
        });
      }}
      onPointerLeave={() =>
        setActive((current) =>
          current?.source === "keyboard" ? current : null,
        )
      }
      onKeyDown={(event) => {
        if (event.key === "Escape" && active) {
          event.preventDefault();
          event.stopPropagation();
          setActive(null);
        }
      }}
    >
      <div className="chart-grid" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      {timeline.map((day, i) => (
        <div
          className={cn(
            "chart-column",
            i === 0 && "is-first",
            i === timeline.length - 1 && "is-last",
          )}
          key={day.timestamp}
        >
          <div className="chart-track">
            <button
              className={cn(
                "chart-bar",
                i === timeline.length - 1 && "is-latest",
                day.words === 0 && "is-empty",
                active?.index === i && "is-highlighted",
              )}
              style={{
                height: day.words
                  ? `${Math.max(2, (day.words / maxWords) * 100)}%`
                  : "3px",
                animationDelay: `${Math.min(i * 25, 400)}ms`,
              }}
              aria-label={`${day.fullLabel}: ${number(day.words)} words, ${day.sessions} ${day.sessions === 1 ? "dictation" : "dictations"}`}
              aria-describedby={active?.index === i ? tooltipId : undefined}
              onFocus={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setActive((current) =>
                  current?.source === "pointer" && current.index === i
                    ? current
                    : {
                        index: i,
                        anchor: { x: rect.left + rect.width / 2, y: rect.top },
                        source: "keyboard",
                      },
                );
              }}
              onBlur={() =>
                setActive((current) =>
                  current?.source === "keyboard" ? null : current,
                )
              }
            />
          </div>
          <span className="chart-label">
            {labelIndices.has(i) ? day.label : ""}
          </span>
        </div>
      ))}
      {active && activeDay && chartRef.current && (
        <FloatingTooltip
          id={tooltipId}
          anchor={active.anchor}
          boundary={chartRef.current}
        >
          {activeDay.fullLabel}
          <strong>
            {number(activeDay.words)} words · {activeDay.sessions} {activeDay.sessions === 1 ? "dictation" : "dictations"}
          </strong>
        </FloatingTooltip>
      )}
      {!hasWords && (
        <div className="chart-empty">
          {hasHistory
            ? "No words in this period"
            : "Activity will appear after your first dictation"}
        </div>
      )}
    </div>
  );
}
