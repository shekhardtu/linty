import { invoke } from "@tauri-apps/api/core";
import { DictationSession } from "@/lib/dictation-session";
import { useAppStore } from "@/store/app.store";

let active = new DictationSession();
let terminalTimer: ReturnType<typeof setTimeout> | undefined;
let recovery: Promise<void> | null = null;

export function currentDictation() { return active; }
export function isRecoveringDictation() { return recovery !== null; }
export function ownsDictation(session: DictationSession) { return session === active; }
export function beginDictation() {
  active.cancel();
  clearTimeout(terminalTimer);
  active = new DictationSession();
  useAppStore.getState().resetTranscription();
  return active;
}

export function showDictationError(message: string, session = active) {
  if (!ownsDictation(session)) return;
  clearTimeout(terminalTimer);
  const state = useAppStore.getState();
  state.resetRecording();
  state.setError(message);
  state.addToast({ type: "error", message });
  // The capsule is often the only visible window. Never leave the explanation
  // exclusively in a toast in the hidden main window.
  void invoke("show_capsule").then(() => {
    if (ownsDictation(session)) return invoke("emit_capsule_state", { state: "error", error: message });
  }).catch(() => {});
  terminalTimer = setTimeout(() => {
    if (!ownsDictation(session)) return;
    useAppStore.getState().resetTranscription();
    void invoke("emit_capsule_state", { state: "idle" }).catch(() => {});
    terminalTimer = setTimeout(() => {
      if (ownsDictation(session)) void invoke("hide_capsule").catch(() => {});
    }, 350);
  }, 6000);
}

export function finishEmptyDictation(session = active, notice: "idle" | "quiet-stop" = "idle") {
  if (!ownsDictation(session) || session.cancelled) return;
  clearTimeout(terminalTimer);
  useAppStore.getState().resetRecording();
  useAppStore.getState().resetTranscription();
  if (notice === "quiet-stop") {
    void invoke("show_capsule").then(() => {
      if (ownsDictation(session)) return invoke("emit_capsule_state", { state: notice });
    }).catch(() => {});
  } else {
    void invoke("emit_capsule_state", { state: notice }).catch(() => {});
  }
  // Let the capsule finish its exit; retain a guarded native fallback.
  terminalTimer = setTimeout(() => {
    if (ownsDictation(session)) void invoke("hide_capsule").catch(() => {});
  }, notice === "quiet-stop" ? 2700 : 350);
}

export function recoverDictation(message: string, session = active): Promise<void> {
  if (!ownsDictation(session)) return Promise.resolve();
  if (recovery) return recovery;
  session.cancel();
  void invoke("cancel_reformatting").catch(() => {});
  showDictationError(message, session);
  // A dead native command must not hold the frontend lock forever. Native
  // recovery invalidates the old audio generation before releasing its buffer.
  recovery = new DictationSession().run(
    () => invoke<void>("recover_recording"), 5000, "Linty did not respond. Quit and reopen Linty.",
  ).catch((error) => {
    showDictationError(String(error instanceof Error ? error.message : error), session);
  }).finally(() => { recovery = null; });
  return recovery;
}
