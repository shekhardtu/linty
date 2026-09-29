import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { AppView } from "@/config/navigation.config";
import { saveSettingsChange } from "@/lib/settings-save-feedback";

interface Consent { available: boolean; enabled: boolean; decided: boolean; epoch: number }
interface Snapshot extends Consent { loaded: boolean; saving: boolean }
let snapshot: Snapshot = { available: false, enabled: false, decided: false, epoch: 0, loaded: false, saving: false };
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const update = (next: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useTelemetry = () => useSyncExternalStore(subscribe, () => snapshot);

export function loadTelemetry() {
  return loading ??= invoke<Consent>("telemetry_snapshot")
    .then(consent => { update({ ...consent, loaded: true }); })
    .catch(() => { update({ available: false, enabled: false, decided: false, loaded: true }); });
}

export async function saveTelemetry(enabled: boolean) {
  if (snapshot.saving) throw new Error("Wait for your sharing preference to finish saving.");
  update({ saving: true });
  try {
    await saveSettingsChange("telemetry", async () => {
      const consent = await invoke<Consent>("telemetry_set_consent", { enabled });
      update(consent);
    });
  } catch (error) {
    // A failed disk write may still have revoked sharing for this session.
    await invoke<Consent>("telemetry_snapshot").then(update).catch(() => {
      update({ enabled: false });
    });
    throw new Error(error instanceof Error ? error.message : typeof error === "string" ? error : "Could not save sharing preferences. Please retry.");
  } finally { update({ saving: false }); }
}

export function reportPage(view: AppView) {
  if (!snapshot.enabled) return;
  const page = view === "system-check" ? "system_check" : view;
  void invoke<void>("telemetry_page_viewed", { page, epoch: snapshot.epoch }).catch(() => {});
}
export function reportOnboardingCompleted() {
  if (snapshot.enabled) void invoke<void>("telemetry_onboarding_completed", { epoch: snapshot.epoch }).catch(() => {});
}
export function reportFrontendError(code: "frontend_error" | "frontend_rejection" | "frontend_render") {
  if (snapshot.enabled) void invoke<void>("telemetry_frontend_error", { code, epoch: snapshot.epoch }).catch(() => {});
}
export function observeFrontendErrors() {
  const error = () => reportFrontendError("frontend_error");
  const rejection = () => reportFrontendError("frontend_rejection");
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}
