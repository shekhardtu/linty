/** Bounds an operation without letting its late result resume an abandoned dictation. */
export class DictationSession {
  private controller = new AbortController();
  get cancelled() { return this.controller.signal.aborted; }
  cancel() { this.controller.abort(); }

  async run<T>(operation: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) throw new Error("Dictation cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const guard = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Dictation cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("Dictation cancelled");
        return operation();
      }), guard]);
      if (signal.aborted) throw new Error("Dictation cancelled");
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// Recording itself has no time limit. Allow longer recordings more inference time.
export function transcriptionTimeoutMs(durationSeconds: number) {
  return Math.max(60_000, (Math.max(0, durationSeconds) * 2 + 30) * 1000);
}
