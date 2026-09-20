/** Human-readable names for local model ids (whisper filenames or the Parakeet bundle id). */
const MODEL_LABELS: Record<string, string> = {
  "ggml-small.bin": "Small",
  "ggml-medium.bin": "Medium",
  "ggml-large-v3-turbo-q5_0.bin": "Large Turbo Q5",
  "parakeet-tdt-0.6b-v3": "Parakeet TDT v3",
  // Retired from the catalog; still needed for history labels and the retirement toast.
  "ggml-large-v3-turbo.bin": "Large Turbo",
  "ggml-large-v3.bin": "Large V3",
};

export function modelLabel(filename: string | null | undefined, fallback = "Local"): string {
  if (!filename) return fallback;
  return MODEL_LABELS[filename] ?? filename;
}
