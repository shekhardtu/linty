import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "@/store/app.store";
import { checkForAppUpdate } from "@/services/updater.service";
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
/// A UI guard for an unresponsive native command. Native networking has its
/// own connection, read and overall check timeouts.
const CHECK_GUARD_MS = 40_000;
const RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/// A required update installs only after dictation has been quiet this long,
/// so a restart never interrupts someone mid-sentence.
const QUIET_BEFORE_INSTALL_MS = 5_000;
const BUSY_UPDATE_STATUSES = new Set(["downloading", "waiting", "verifying", "installing", "restarting"]);

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
  let timedOut = false;
  const guard = new Promise<never>((_, reject) => {
    guardTimer = setTimeout(() => { timedOut = true; reject(new UpdateCheckTimeout()); }, CHECK_GUARD_MS);
  });
  const check = checkForAppUpdate().then(update => {
    if (!timedOut) return update;
    // A late IPC reply must not leak its native updater resource.
    update?.close().catch(() => {});
    return null;
  });
  return Promise.race([check, guard]).finally(() => {
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
    latest = await checkWithTimeout();
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

async function restartInstalledUpdate() {
  const store = useAppStore.getState();
  store.setUpdateError(null);
  store.setUpdateStatus("restarting");
  try {
    await relaunch();
  } catch {
    store.setUpdateError("The update is installed, but Linty could not restart. Try restarting again.");
    useAppStore.setState({ updateStatus: "error", updateNoticeDismissed: false });
  }
}

async function installAndRestart(update: Update) {
  await update.install();
  useAppStore.setState({ updateRestartPending: true });
  await restartInstalledUpdate();
}

/// Download in the background, finish active dictation, then install and restart.
/// Hiding the notice never changes this lifecycle.
async function installRequiredUpdate(update: Update) {
  if (activeRequiredUpdate) return;
  activeRequiredUpdate = update;
  const store = useAppStore.getState();
  try {
    store.setUpdateError(null);
    store.setUpdateProgress(0);
    useAppStore.setState({ updateNoticeDismissed: false });
    store.setUpdateStatus("downloading");
    await update.download(progressHandler());

    store.setUpdateStatus("waiting");
    await waitUntilIdle(
      () => isDictationBusy(useAppStore.getState()),
      useAppStore.subscribe,
      QUIET_BEFORE_INSTALL_MS,
      undefined,
      quiet => useAppStore.setState({ updateRestartAt: quiet ? Date.now() + QUIET_BEFORE_INSTALL_MS : null }),
    );

    // The minimum may have been cleared while this waited.
    store.setUpdateStatus("verifying");
    if (!(await stillRequired(update))) {
      store.setUpdateRequired(false);
      store.setUpdateStatus("idle");
      return;
    }

    store.setUpdateStatus("waiting");
    await claimIdleForUpdate(
      () => isDictationBusy(useAppStore.getState()),
      useAppStore.subscribe,
      () => store.setUpdateStatus("installing"),
    );
    await installAndRestart(update);
  } catch (err) {
    console.error("[updater] Required update failed:", err);
    store.setUpdateError("The update could not be installed. Check your connection and try again.");
    store.setUpdateStatus("error");
    useAppStore.setState({ updateNoticeDismissed: false });
  } finally {
    activeRequiredUpdate = null;
    useAppStore.setState({ updateRestartAt: null });
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
    if (useAppStore.getState().updateRestartPending) return restartInstalledUpdate();
    // Reuse a check already in flight (the silent auto-check, typically) so a
    // click during it still reports the outcome instead of doing nothing.
    inFlightCheck ??= checkWithTimeout();
    try {
      setUpdateStatus("checking");
      setUpdateError(null);
      const update = await inFlightCheck;

      // An offered update can return to idle if its requirement is revoked.
      // Only a check with no newer release confirms this copy is current.
      useAppStore.setState({ updateCheckedAt: update ? null : Date.now(), updateNotes: update?.body ?? null });

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
      // Background failures stay visible in About and the sidebar. Keeping
      // this out of the toast stream avoids interrupting dictation.
      setUpdateError(
        err instanceof UpdateCheckTimeout
          ? "The update server did not respond. Check your connection and try again."
          : "Could not check for updates. Check your connection and try again.",
      );
      setUpdateStatus("error");
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
      await installAndRestart(update);
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
 * Auto-check at launch, every 15 minutes and on wake. Failed checks retry
 * after 1, 2, 4, then 5 minutes until a check succeeds.
 * Call this ONCE in App.tsx — not in every component that uses useUpdater().
 */
export function useUpdaterAutoCheck() {
  const { checkForUpdate } = useUpdater();

  useEffect(() => {
    if (autoCheckActive) return;
    autoCheckActive = true;

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_DELAY_MS;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.updateStatus === previous.updateStatus) return;
      clearTimeout(retryTimer);
      if (state.updateStatus === "error") {
        retryTimer = setTimeout(() => { void checkForUpdate(true); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      } else if (state.updateStatus === "idle" || state.updateStatus === "available") {
        retryDelay = RETRY_DELAY_MS;
      }
    });

    const timeout = setTimeout(() => checkForUpdate(true), CHECK_DELAY_MS);
    const interval = setInterval(() => checkForUpdate(true), CHECK_INTERVAL_MS);
    const unlistenWake = listen("system-wake", () => {
      void checkForUpdate(true);
    });
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      clearTimeout(retryTimer);
      unsubscribe();
      void unlistenWake.then((unlisten) => unlisten());
      autoCheckActive = false;
    };
  }, [checkForUpdate]);
}
