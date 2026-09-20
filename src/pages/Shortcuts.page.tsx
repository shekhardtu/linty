import { useSettings } from "@/hooks/useSettings.hook";
import {
  FALLBACK_TRIGGER_ACCELERATOR,
} from "@/store/slices/settings.slice";
import {
  isModifierHoldTrigger,
  formatTriggerDisplay,
} from "@/lib/trigger.util";
import { TriggerKeyPicker } from "@/components/shared/TriggerKeyPicker.component";
import {
  PageLayout,
  PageHeader,
} from "@/components/shared/PageLayout.component";
import { formatTriggerKeycap } from "@/lib/trigger.util";

const STATIC_SHORTCUTS = [
  { action: "Search Linty", mac: "⌘K" },
  { action: "Show / hide sidebar", mac: "⌃⌘S" },
  { action: "Settings", mac: "⌘," },
  { action: "Search history", mac: "⌘F" },
  { action: "Copy selected transcript", mac: "⌘C" },
  { action: "Dismiss / Back", mac: "Esc" },
  { action: "Quit", mac: "⌘Q" },
];

export function ShortcutsPage() {
  const { triggerKey, saveTriggerKey } = useSettings();

  const shortcuts = [
    { action: "Push-to-talk", mac: formatTriggerDisplay(triggerKey) },
    { action: "Start hands-free listening", mac: `${formatTriggerKeycap(triggerKey)} × 2` },
    { action: "Finish hands-free listening", mac: `${formatTriggerKeycap(triggerKey)} × 1` },
    // modifier-hold users keep the always-registered alternate combo
    ...(isModifierHoldTrigger(triggerKey)
      ? [
          {
            action: "Push-to-talk (alt)",
            mac: formatTriggerDisplay(FALLBACK_TRIGGER_ACCELERATOR),
          },
        ]
      : []),
    ...STATIC_SHORTCUTS,
  ];

  return (
    <PageLayout reading>
      <PageHeader page="shortcuts" />
      <div className="shortcuts-hero">
        <kbd>{formatTriggerKeycap(triggerKey)}</kbd>
        <div>
          <h2>Hold, speak, release.</h2>
          <p>Or double-press your trigger to keep listening. Press once to finish.</p>
        </div>
      </div>
      <div className="mb-2.5">
        <span className="text-[13px] font-semibold text-text-primary">
          Trigger Key
        </span>
      </div>
      <TriggerKeyPicker
        value={triggerKey}
        onChange={saveTriggerKey}
        className="mb-6"
      />
      <p className="mb-6 text-[12px] leading-relaxed text-text-secondary">
        Both gestures work with any trigger you choose and the alternate shortcut.
        After 20 seconds without input, Linty checks if you’re still talking.
        Speak to continue, or listening stops at 30 seconds.
      </p>

      <div className="mb-2.5">
        <span className="text-[13px] font-semibold text-text-primary">
          Shortcuts
        </span>
      </div>
      <div className="shortcut-list">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.action}>
            <span>{shortcut.action}</span>
            <kbd>{shortcut.mac}</kbd>
          </div>
        ))}
      </div>
    </PageLayout>
  );
}
