import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";

/** Use Linty's bounded connection handling, then retain the plugin's signed
 * download/install resource and progress events. */
export async function checkForAppUpdate(): Promise<Update | null> {
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("check_for_update");
  return metadata ? new Update(metadata) : null;
}
