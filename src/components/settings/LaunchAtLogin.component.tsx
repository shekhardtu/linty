import { useEffect, useRef, useState } from "react";
import { Toggle } from "@/components/shared/Toggle.component";
import { useStartupSettings } from "@/hooks/useStartupSettings.hook";
import { openLoginItemsSettings } from "@/services/startup.service";
import { useAppStore } from "@/store/app.store";

export function LaunchAtLogin() {
  const { settings, saving, error, save, refresh } = useStartupSettings();
  const [openError, setOpenError] = useState("");
  const target = useAppStore((state) => state.settingsTarget);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target !== "launch-at-login" || !settings) return;
    const row = element.current;
    const toggle = row?.querySelector<HTMLButtonElement>('button[role="switch"]');
    row?.scrollIntoView({ block: "nearest" });
    (toggle && !toggle.disabled ? toggle : row)?.focus({ preventScroll: true });
    useAppStore.getState().clearSettingsTarget();
  }, [target, settings]);
  return <div id="launch-at-login" ref={element} tabIndex={-1}>
    <Toggle label="Launch at login" enabled={settings?.status === "enabled"}
      disabled={!settings || saving || settings.status === "unavailable"}
      onChange={(enabled) => { void save(enabled); }}
      description="Keep Linty ready in the menu bar when you sign in to your Mac." />
    {(error || openError) && <p role="alert" className="px-4 pb-3 text-sm text-error">{error || openError}</p>}
    {!settings && error && <button className="text-link px-4 pb-3" onClick={() => { void refresh(); }}>Try again</button>}
    {settings?.status === "requiresApproval" && <div className="px-4 pb-3 text-sm text-text-secondary">
      <p>Allow Linty in macOS Login Items to launch automatically.</p>
      <button className="text-link" onClick={() => { void openLoginItemsSettings().catch(() => setOpenError("Could not open Login Items. Try again.")); }}>Open Login Items</button>
      <button className="text-link ml-4" disabled={saving} onClick={() => { void save(false); }}>Turn off launch at login</button>
    </div>}
    {settings?.status === "unavailable" && <p className="px-4 pb-3 text-sm text-text-secondary">Install Linty in Applications to use launch at login.</p>}
    {!settings && !error && <p role="status" className="px-4 pb-3 text-sm text-text-secondary">Checking launch at login…</p>}
  </div>;
}
