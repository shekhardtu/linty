// Only the selected recording enters the webview. Native storage
// and export stream independently, including recordings beyond this limit.
export const AUDIO_CHUNK_BYTES = 1024 * 1024;
export const MAX_AUDIO_PLAYBACK_BYTES = 64 * 1024 * 1024;

export async function loadHistoryAudio(
  bytes: number,
  read: (offset: number, length: number) => Promise<ArrayBuffer | number[]>,
  signal: AbortSignal,
): Promise<Blob> {
  if (!Number.isSafeInteger(bytes) || bytes < 44 || bytes > MAX_AUDIO_PLAYBACK_BYTES) {
    throw new Error("Export this recording as WAV to listen outside Linty.");
  }
  const parts: BlobPart[] = [];
  for (let offset = 0; offset < bytes; offset += AUDIO_CHUNK_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(AUDIO_CHUNK_BYTES, bytes - offset);
    const data = await read(offset, length);
    signal.throwIfAborted();
    const part = data instanceof ArrayBuffer ? data : new Uint8Array(data);
    if (part.byteLength !== length) throw new Error("Saved recording is incomplete or was deleted.");
    parts.push(part);
  }
  return new Blob(parts, { type: "audio/wav" });
}
