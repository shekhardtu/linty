import { getVersion } from "@tauri-apps/api/app";
import { getSettingsStore } from "@/hooks/useSettings.hook";
import { reconcileUpdateHistory, type UpdateHistory } from "@/lib/update-acknowledgment";

const KEY = "updateHistory";
let initialization: Promise<UpdateHistory> | null = null;

/** One initialization, including under React StrictMode and simultaneous hooks. */
export function initializeUpdateHistory(returningCustomer: boolean) {
  initialization ??= (async () => {
    const [store, version] = await Promise.all([getSettingsStore(), getVersion()]);
    const history = reconcileUpdateHistory(await store.get(KEY), version, returningCustomer);
    await store.set(KEY, history);
    await store.save();
    return history;
  })().catch(error => {
    initialization = null;
    throw error;
  });
  return initialization;
}

export async function acknowledgeUpdate() {
  if (!initialization) return;
  const history = await initialization;
  const store = await getSettingsStore();
  const acknowledged: UpdateHistory = { ...history, notice: null };
  try {
    await store.set(KEY, acknowledged);
    await store.save();
    initialization = Promise.resolve(acknowledged);
  } catch (error) {
    await store.set(KEY, history).catch(() => {});
    throw error;
  }
}
