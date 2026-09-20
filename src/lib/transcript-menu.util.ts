import { Menu } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "@/store/app.store";
import type { TranscriptRecord } from "@/types/transcript.types";

/** Let macOS own context-menu placement, keyboard navigation, and dismissal. */
export async function showTranscriptMenu(record: TranscriptRecord, onDelete: (id: string) => Promise<void>) {
  const notify = useAppStore.getState().addToast;
  let menu: Menu | undefined;
  try {
    menu = await Menu.new({ items: [
      { id: `copy-${record.transcriptId}`, text: "Copy Transcription", action: async () => {
        try { await writeText(record.finalText); notify({ type: "success", message: "Copied to clipboard" }); }
        catch { notify({ type: "error", message: "Could not copy transcription. Please try again." }); }
      } },
      { id: `delete-${record.transcriptId}`, text: "Delete Transcription", action: async () => {
        try { await onDelete(record.transcriptId); }
        catch { notify({ type: "error", message: "Could not delete transcription. Please try again." }); }
      } },
    ] });
    await menu.popup();
  } catch {
    notify({ type: "error", message: "Could not open the menu. Use the Copy or Delete buttons." });
  } finally { await menu?.close().catch(() => {}); }
}
