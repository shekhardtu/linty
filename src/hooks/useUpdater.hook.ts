import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "@/store/app.store";
import {
  isDictationBusy,
  isUpdateRequired,
  minimumVersion,
  waitUntilIdle,
  claimIdleForUpdate,
} from "@/lib/force-update.util";

const CHECK_DELAY_MS = 5_000;
/// Short enough that a required update reaches running copies within the
/// hour it is published.
const CHECK_INTERVAL_MS = 15 * 60 * 1_000;
/// The updater plugin has no timeout of its own: a stalled connection to the
/// release feed would leave "Check for updates" spinning forever.
const CHECK_TIMEOUT_MS = 30_000;
const CHECK_GUARD_MS = 40_000;
/// A required update installs only after dictation has been quiet this long,
/// so a restart never interrupts someone mid-sentence.
const QUIET_BEFORE_INSTALL_MS = 30_000;
const BUSY_UPDATE_STATUSES = new Set(["downloading", "waiting", "installing"]);

// Module-level singletons — shared across all hook instances so
// downloadAndInstall always has the update object regardless of
// which component called checkForUpdate, and so a manual check joins a
// silent check that is already in flight instead of being ignored.
let pendingUpdate: Update | null = null;
let inFlightCheck: Promise<Update | null> | null = null;
/// The update a required install is working on, if any.
let activeRequiredUpdate: Update | null = null;
let autoCheckActive = false;

/// Each found Update is a Rust-side resource; close the one being replaced
/// unless a required install is still using it.
function replacePendingUpdate(next: Update | null) {
  const previous = pendingUpdate;
  pendingUpdate = next;
  if (previous && previous !== next && previous !== activeRequiredUpdate) {
    previous.close().catch(() => {});
  }
}

function checkWithTimeout() {
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    guardTimer = setTimeout(() => reject(new UpdateCheckTimeout()), CHECK_GUARD_MS);
  });
  return Promise.race([check({ timeout: CHECK_TIMEOUT_MS }), guard]).finally(() => {
    clearTimeout(guardTimer);
    inFlightCheck = null;
  });
}

class UpdateCheckTimeout extends Error {
  constructor() {
    super("Update check timed out");
    this.name = "UpdateCheckTimeout";
  }
}

/// latest.json's minimum_version says this copy must take the offered release.
function required(update: Update) {
  return isUpdateRequired(update.currentVersion, update.version, minimumVersion(update.rawJson));
}

/// Just before installing: is the release still required? A failed check
/// keeps the downloaded, already required release.
async function stillRequired(update: Update) {
  let latest: Update | null;
  try {
    latest = await check({ timeout: CHECK_TIMEOUT_MS });
  } catch {
    return true;
  }
  const answer = latest !== null && latest.version === update.version && required(latest);
  latest?.close().catch(() => {});
  return answer;
}

function progressHandler() {
  const { setUpdateProgress } = useAppStore.getState();
  let contentLength = 0;
  let downloaded = 0;
  return (event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength ?? 0;
        downloaded = 0;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          setUpdateProgress(Math.min(Math.round((downloaded / contentLength) * 100), 100));
        }
        break;
      case "Finished":
        setUpdateProgress(100);
        break;
    }
  };
}

/// Download now, install once dictation is quiet, then restart. The blocking
/// screen (UpdateRequired) shows each step; failures leave a retry there and
/// the next check tries again.
async function installRequiredUpdate(update: Update) {
  if (activeRequiredUpdate) return;
  activeRequiredUpdate = update;
  const store = useAppStore.getState();
  try {
    store.setUpdateError(null);
    store.setUpdateProgress(0);
    store.setUpdateStatus("downloading");
    await update.download(progressHandler());

    store.setUpdateStatus("waiting");
    await waitUntilIdle(
      () => isDictationBusy(useAppStore.getState()),
      useAppStore.subscribe,
      QUIET_BEFORE_INSTALL_MS,
    );

    // The minimum may have been cleared while this waited.
    if (!(await stillRequired(update))) {
      store.setUpdateRequired(false);
      store.setUpdateStatus("idle");
      return;
    }

    await claimIdleForUpdate(
      () => isDictationBusy(useAppStore.getState()),
      useAppStore.subscribe,
      () => store.setUpdateStatus("installing"),
    );
    await update.install();
    await relaunch();
  } catch (err) {
    console.error("[updater] Required update failed:", err);
    store.setUpdateError("The update could not be installed. Check your connection and try again.");
    store.setUpdateStatus("error");
  } finally {
    activeRequiredUpdate = null;
    if (pendingUpdate !== update) update.close().catch(() => {});
  }
}

export function useUpdater() {
  const setUpdateStatus = useAppStore((s) => s.setUpdateStatus);
  const setUpdateVersion = useAppStore((s) => s.setUpdateVersion);
  const setUpdateCurrentVersion = useAppStore((s) => s.setUpdateCurrentVersion);
  const setUpdateRequired = useAppStore((s) => s.setUpdateRequired);
  const setUpdateError = useAppStore((s) => s.setUpdateError);
  const setUpdateProgress = useAppStore((s) => s.setUpdateProgress);
  const addToast = useAppStore((s) => s.addToast);

  const checkForUpdate = useCallback(async (silent = false) => {
    if (BUSY_UPDATE_STATUSES.has(useAppStore.getState().updateStatus)) return;
    // Reuse a check already in flight (the silent auto-check, typically) so a
    // click during it still reports the outcome instead of doing nothing.
    inFlightCheck ??= checkWithTimeout();
    try {
      setUpdateStatus("checking");
      setUpdateError(null);
      const update = await inFlightCheck;

      useAppStore.setState({ updateCheckedAt: Date.now(), updateNotes: update?.body ?? null });

      replacePendingUpdate(update);
      if (update) {
        setUpdateVersion(update.version);
        setUpdateCurrentVersion(update.currentVersion);
        const isRequired = required(update);
        setUpdateRequired(isRequired);
        if (isRequired) {
          void installRequiredUpdate(update);
          return;
        }
        setUpdateStatus("available");
        addToast({
          type: "info",
          message: `Update v${update.version} available`,
        });
      } else {
        setUpdateVersion(null);
        setUpdateCurrentVersion(null);
        setUpdateRequired(false);
        setUpdateStatus("idle");
        if (!silent) addToast({ type: "success", message: "You’re using the latest version of Linty." });
      }
    } catch (err) {
      console.error("[updater] Check failed:", err);
      useAppStore.setState({ updateCheckedAt: null });
      if (silent && !useAppStore.getState().updateRequired) setUpdateStatus("idle");
      else {
        setUpdateError(
          err instanceof UpdateCheckTimeout
            ? "The update server did not respond. Check your connection and try again."
            : "Could not check for updates. Check your connection and try again.",
        );
        setUpdateStatus("error");
      }
    }
  }, [setUpdateStatus, setUpdateVersion, setUpdateCurrentVersion, setUpdateRequired, setUpdateError, addToast]);

  const downloadAndInstall = useCallback(async () => {
    const update = pendingUpdate;
    if (!update || BUSY_UPDATE_STATUSES.has(useAppStore.getState().updateStatus)) return;

    try {
      setUpdateStatus("downloading");
      setUpdateProgress(0);
      setUpdateError(null);

      await update.download(progressHandler());
      setUpdateStatus("waiting");
      await claimIdleForUpdate(
        () => isDictationBusy(useAppStore.getState()),
        useAppStore.subscribe,
        () => setUpdateStatus("installing"),
      );
      await update.install();

      addToast({ type: "success", message: "Update installed — restarting..." });
      // Brief delay so the user sees the toast
      await new Promise((r) => setTimeout(r, 1500));
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[updater] Download failed:", message);
      setUpdateError(message);
      setUpdateStatus("error");
      addToast({ type: "error", message: "Update failed — try again later" });
    }
  }, [setUpdateStatus, setUpdateProgress, setUpdateError, addToast]);

  return { checkForUpdate, downloadAndInstall };
}

/**
 * Auto-check 5 s after launch, every 15 minutes, and when the Mac wakes.
 * Call this ONCE in App.tsx — not in every component that uses useUpdater().
 */
export function useUpdaterAutoCheck() {
  const { checkForUpdate } = useUpdater();

  useEffect(() => {
    if (autoCheckActive) return;
    autoCheckActive = true;

    const timeout = setTimeout(() => checkForUpdate(true), CHECK_DELAY_MS);
    const interval = setInterval(() => checkForUpdate(true), CHECK_INTERVAL_MS);
    const unlistenWake = listen("system-wake", () => {
      void checkForUpdate(true);
    });
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      void unlistenWake.then((unlisten) => unlisten());
      autoCheckActive = false;
    };
  }, [checkForUpdate]);
}
