import { useLayoutEffect, useRef, type UIEvent } from "react";

// Session-only, bounded: no saved transcripts or form data are retained here.
const positions = new Map<string, number>();

/** Restore once content is ready, before paint; background refreshes keep the current scroll. */
export function useScrollMemory(key: string, ready = true) {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (restored.current === key || !ready || !ref.current) return;
    ref.current.scrollTop = positions.get(key) ?? 0;
    restored.current = key;
  }, [key, ready]);
  return {
    ref,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (!ready || restored.current !== key) return;
      positions.delete(key);
      positions.set(key, event.currentTarget.scrollTop);
      if (positions.size > 50) positions.delete(positions.keys().next().value!);
    },
  };
}
