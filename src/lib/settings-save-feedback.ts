export type SettingsSaveStatus = "idle" | "saving" | "saved" | "error";

/** Shared across pages, and driven by completed persistence operations. */
export function createSettingsSaveFeedback() {
  let status: SettingsSaveStatus = "idle";
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failures = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: SettingsSaveStatus) => {
    status = next;
    listeners.forEach((listener) => listener());
  };
  const settle = () => {
    if (pending) return;
    if (failures.size) { publish("error"); return; }
    // Let even a fast local write give a quiet, readable processing cue.
    timer = setTimeout(() => {
      publish("saved");
      timer = setTimeout(() => publish("idle"), 2500);
    }, 300);
  };
  return {
    getSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      clearTimeout(timer);
      pending += 1;
      publish("saving");
      try {
        const result = await work();
        failures.delete(key);
        return result;
      } catch (error) {
        failures.add(key);
        throw error;
      } finally {
        pending -= 1;
        settle();
      }
    },
  };
}

/** Rollbacks must finish before a newer preference can write to the same store. */
export function createSettingsWriter(feedback: ReturnType<typeof createSettingsSaveFeedback>) {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => feedback.run(key, () => {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  });
}

export const settingsSaveFeedback = createSettingsSaveFeedback();
export const saveSettingsChange = createSettingsWriter(settingsSaveFeedback);
