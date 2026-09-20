import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "@/store/app.store";
import type { TranscriptRecord } from "@/types/transcript.types";

/** Copy the complete saved text and report the clipboard result consistently. */
export async function copyTranscript(
  record: TranscriptRecord,
): Promise<boolean> {
  const notify = useAppStore.getState().addToast;
  try {
    await writeText(record.finalText);
    notify({ type: "success", message: "Copied to clipboard" });
    return true;
  } catch {
    notify({
      type: "error",
      message: "Could not copy transcription. Please try again.",
    });
    return false;
  }
}
