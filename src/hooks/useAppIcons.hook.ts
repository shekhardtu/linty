import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Bundle id → PNG data URL (null when the app has no resolvable icon). Session-lifetime cache. */
const iconCache = new Map<string, string | null>();
/** In-flight requests so concurrent rows asking for the same app share one IPC call. */
const inFlight = new Map<string, Promise<void>>();

async function fetchIcons(bundleIds: string[]) {
  try {
    const icons = await invoke<Record<string, string | null> | null>("get_app_icons", { bundleIds });
    for (const id of bundleIds) iconCache.set(id, icons?.[id] ?? null);
  } catch {
    for (const id of bundleIds) iconCache.set(id, null);
  } finally {
    for (const id of bundleIds) inFlight.delete(id);
  }
}

/**
 * Resolves macOS app icons for the given bundle ids, returned as PNG data URLs.
 * Missing entries resolve to null; components fall back to a letter avatar.
 */
export function useAppIcons(bundleIds: (string | null | undefined)[]): Record<string, string | null> {
  const key = [...new Set(bundleIds.filter((id): id is string => !!id))].sort().join("\n");
  const ids = useMemo(() => (key ? key.split("\n") : []), [key]);
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!ids.length) return;
    let cancelled = false;
    const missing = ids.filter((id) => !iconCache.has(id) && !inFlight.has(id));
    if (missing.length) {
      const request = fetchIcons(missing);
      for (const id of missing) inFlight.set(id, request);
    }
    const awaiting = ids.map((id) => inFlight.get(id)).filter(Boolean);
    if (awaiting.length) {
      void Promise.all(awaiting).then(() => {
        if (!cancelled) rerender((n) => n + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [ids]);

  return Object.fromEntries(ids.map((id) => [id, iconCache.get(id) ?? null]));
}

/** Single-app convenience wrapper around useAppIcons. */
export function useAppIcon(bundleId: string | null | undefined): string | null {
  const icons = useAppIcons([bundleId]);
  return bundleId ? (icons[bundleId] ?? null) : null;
}
