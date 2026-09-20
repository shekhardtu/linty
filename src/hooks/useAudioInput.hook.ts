import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";
import { settingsSaveFeedback } from "@/lib/settings-save-feedback";

export interface AudioInputs {
  selected: string | null;
  defaultDevice: string | null;
  devices: { name: string; selectable: boolean }[];
  error: string | null;
}

export function audioInputOptions(inputs: AudioInputs | null) {
  const options = [
    { value: "", label: inputs?.defaultDevice ? `System Default — ${inputs.defaultDevice}` : "System Default", disabled: false },
    ...(inputs?.devices.map((device) => ({ value: device.name, label: device.selectable ? device.name : `${device.name} (multiple devices)`, disabled: !device.selectable })) ?? []),
  ];
  if (inputs?.selected && !inputs.devices.some((device) => device.name === inputs.selected)) {
    options.push({ value: inputs.selected, label: `${inputs.selected} (Unavailable)`, disabled: true });
  }
  return options;
}

/** Native state owns persistence and device discovery; this is a UI projection. */
export function useAudioInput() {
  const [inputs, setInputs] = useState<AudioInputs | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unlisten = listen<AudioInputs>("audio-input-changed", ({ payload }) => {
      receivedEvent = true;
      if (active) { setInputs(payload); setError(null); }
    });
    unlisten.then(async () => {
      const snapshot = await invoke<AudioInputs>("get_audio_inputs");
      if (active && !receivedEvent) setInputs(snapshot);
    }).catch(() => { if (active) setError("Could not load microphones. Reopen this view to try again."); });
    return () => { active = false; unlisten.then((off) => off()).catch(() => {}); };
  }, []);

  const select = async (value: string) => {
    setSaving(true);
    try {
      const snapshot = await settingsSaveFeedback.run("audioInput", () => invoke<AudioInputs>("set_audio_input", { name: value || null }));
      setInputs(snapshot);
      setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      useAppStore.getState().addToast({ type: "error", message });
    } finally { setSaving(false); }
  };
  return { inputs, saving, error: error ?? inputs?.error, select };
}
