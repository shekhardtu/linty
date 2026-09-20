import { invoke } from "@tauri-apps/api/core";

export async function checkMicrophonePermission(): Promise<string> {
  return invoke<string>("check_microphone");
}

export async function requestMicrophonePermission(): Promise<boolean> {
  return invoke<boolean>("request_microphone");
}

export async function checkAccessibility(): Promise<boolean> {
  return invoke<boolean>("check_accessibility");
}

export async function requestAccessibility(): Promise<boolean> {
  return invoke<boolean>("request_accessibility");
}

export async function reinitFnKeyMonitor(): Promise<void> {
  return invoke("reinit_fn_key_monitor");
}

/** System-level fn key binding (AppleFnUsageType). Only 0 ("Do Nothing") is conflict-free. */
export interface FnKeyConflict {
  usage_type: number | null;
  conflict: boolean;
}

export async function checkFnKeyConflict(): Promise<FnKeyConflict> {
  return invoke<FnKeyConflict>("check_fn_key_conflict");
}

export async function openSystemSettings(pane: "microphone" | "accessibility" | "keyboard"): Promise<void> {
  const urls: Record<string, string> = {
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
  };
  return invoke("open_system_settings", { pane: urls[pane] });
}
