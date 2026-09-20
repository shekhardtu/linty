import { useId, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { useDictionary } from "@/hooks/useDictionary.hook";
import { formatTriggerLabel, formatTriggerKeycap } from "@/lib/trigger.util";
import { SectionHeading } from "@/components/shared/PageLayout.component";
import { BackgroundArtwork } from "@/components/shared/BackgroundArtwork.component";

/** Manual, useful discoveries. Content comes from the same app state as each destination. */
export function OverviewWidgets() {
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  const trigger = useAppStore((s) => s.triggerKey);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const { entries, readySuggestions } = useDictionary();
  const milestone = useAppStore((s) => s.historySnapshot.milestone);
  const standardWidgets = [
    {
      label: "Shortcut tip",
      title: "Hold. Speak. Done.",
      text: `Hold ${formatTriggerLabel(trigger)} to dictate. Release to paste your words.`,
      icon: <kbd>{formatTriggerKeycap(trigger)}</kbd>,
      action: "Your shortcuts",
      view: "shortcuts" as const,
    },
    {
      label: "Your dictionary",
      title: "Names worth remembering.",
      text: readySuggestions.length
        ? `${readySuggestions.length} suggestion${readySuggestions.length === 1 ? "" : "s"} ready to review.`
        : entries.length
          ? `${entries.length} word${entries.length === 1 ? "" : "s"} in your dictionary. Make every name feel at home.`
          : "Add names and terms you use often, so Linty gets them right.",
      icon: <BookOpen size={22} />,
      action: "Open dictionary",
      view: "dictionary" as const,
    },
    {
      label: "Your words",
      title: "A thought, ready to find.",
      text: "Search your history by a word or an app. Your last idea is never far away.",
      icon: <Clock3 size={22} />,
      action: "Find a transcription",
      view: "history" as const,
    },
  ];
  const milestoneWidget = milestone
    ? {
        label: "A little milestone",
        title: `${milestone.words.toLocaleString(undefined, milestone.words >= 1_000_000 ? { notation: "compact", maximumFractionDigits: 1 } : undefined)} words. Yours.`,
        text: `Your saved history crossed ${milestone.words.toLocaleString()} words on ${new Date(milestone.timestamp).toLocaleDateString([], { day: "numeric", month: "short", year: new Date(milestone.timestamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}. One thought at a time.`,
        icon: <Sparkles size={20} />,
        action: null,
        view: "history" as const,
      }
    : null;
  // Recognition replaces the discovery about History, which is already linked beside recent rows.
  const widgets = milestoneWidget
    ? [milestoneWidget, ...standardWidgets.slice(0, 2)]
    : standardWidgets;
  const active = Math.max(
    0,
    widgets.findIndex((widget) => widget.label === selected),
  );
  const select = (index: number) =>
    setSelected(widgets[(index + widgets.length) % widgets.length].label);
  return (
    <section
      className="overview-widgets"
      aria-roledescription="carousel"
      aria-label="For your flow"
    >
      <SectionHeading title="For your flow" />
      <div
        className="widget-stack"
        id={id}
        aria-live="polite"
        aria-atomic="true"
      >
        {widgets.map((widget, index) => (
          <div
            key={widget.label}
            className={`widget-surface${index === active ? " is-active" : ""}`}
            aria-hidden={index !== active}
            inert={index !== active}
          >
            <div className="widget-kicker">
              <span>{widget.label}</span>
              {widget.icon}
            </div>
            <div className="widget-copy">
              <h3>{widget.title}</h3>
              <p>{widget.text}</p>
            </div>
            {widget.action ? (
              <button
                className="text-link"
                onClick={() => setCurrentView(widget.view)}
              >
                {widget.action}
                <ArrowRight size={13} />
              </button>
            ) : (
              <span className="widget-source">From your saved history</span>
            )}
            <BackgroundArtwork motif="contour" />
          </div>
        ))}
      </div>
      <div className="widget-controls">
        <div className="widget-dots" role="group" aria-label="Choose a widget">
          {widgets.map((item, index) => (
            <button
              key={item.label}
              aria-label={`Show ${item.label.toLowerCase()}`}
              data-tooltip={`Show ${item.label.toLowerCase()}`}
              aria-pressed={index === active}
              aria-controls={id}
              onClick={() => select(index)}
            >
              <i />
            </button>
          ))}
        </div>
        <span>
          {active + 1} / {widgets.length}
        </span>
        <button
          className="icon-button"
          aria-label="Previous widget"
          data-tooltip="Previous widget"
          aria-controls={id}
          onClick={() => select(active - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="icon-button"
          aria-label="Next widget"
          data-tooltip="Next widget"
          aria-controls={id}
          onClick={() => select(active + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}
