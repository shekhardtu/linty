/**
 * Force updates without a server. A release's `latest.json` on GitHub may
 * carry `minimum_version`; a copy below it must install the release it is
 * offered. The field is not signed, and it does not need to be: the updater
 * still installs only the newest release, verified with the release key, so
 * the field can never make a copy install anything else.
 *
 * No imports: scripts/force-update.mjs uses this file too.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersion(text: unknown): text is string {
  return typeof text === "string" && VERSION.test(text.trim());
}

/** Semver order (build metadata ignored); a leading "v" is allowed. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a.trim());
  const pb = VERSION.exec(b.trim());
  if (!pa || !pb) throw new Error(`Not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

export function normalizeVersion(text: string): string {
  return text.trim().replace(/^v/, "");
}

/** `minimum_version` from a release manifest, or null if absent or unreadable. */
export function minimumVersion(manifest: unknown): string | null {
  const value = (manifest as { minimum_version?: unknown } | null | undefined)?.minimum_version;
  return isVersion(value) ? normalizeVersion(value) : null;
}

/**
 * The offered release is required when this copy is below the minimum and
 * the offered release meets it. A minimum above every release forces nothing.
 */
export function isUpdateRequired(current: string, offered: string, minimum: string | null): boolean {
  if (minimum === null || !isVersion(current) || !isVersion(offered)) return false;
  return compareVersions(current, minimum) < 0 && compareVersions(offered, minimum) >= 0;
}

/**
 * The manifest with its minimum set to `minimum`, or removed when null.
 * Refuses a minimum above the release itself, and lowering an existing
 * minimum unless `allowLower` is set.
 */
export function withMinimumVersion(
  manifest: Record<string, unknown>,
  minimum: string | null,
  { allowLower = false }: { allowLower?: boolean } = {},
): Record<string, unknown> {
  const release = manifest.version;
  if (!isVersion(release)) throw new Error("latest.json has no readable version");
  const { minimum_version: _previous, ...rest } = manifest;
  const current = minimumVersion(manifest);
  if (minimum === null) {
    if (current !== null && !allowLower) throw new Error(`Clearing the minimum (${current}) needs --allow-lower`);
    return rest;
  }
  if (!isVersion(minimum)) throw new Error(`Not a version: ${minimum}`);
  const next = normalizeVersion(minimum);
  if (compareVersions(next, release) > 0) {
    throw new Error(`The minimum ${next} is above the release ${normalizeVersion(release)}; no copy could meet it`);
  }
  if (current !== null && compareVersions(next, current) < 0 && !allowLower) {
    throw new Error(`Lowering the minimum from ${current} to ${next} needs --allow-lower`);
  }
  return { ...rest, minimum_version: next };
}

/** Transcription states during which an update must not restart the app. */
const BUSY_STATUSES = new Set(["preparing", "recording", "transcribing", "correcting", "pasting"]);

export function isDictationBusy(state: { isRecording: boolean; status: string }): boolean {
  return state.isRecording || BUSY_STATUSES.has(state.status);
}

export interface IdleTimers {
  set: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
}

// Wrapped: WebKit and Chromium throw "Illegal invocation" when setTimeout is
// called as a method of another object.
const browserTimers: IdleTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer),
};

/**
 * Resolves once `isBusy()` has been false for `quietMs` without interruption.
 * `subscribe` is a store subscription (returns its unsubscribe function); the
 * timer restarts only when dictation starts, not on unrelated store changes.
 */
export function waitUntilIdle(
  isBusy: () => boolean,
  subscribe: (listener: () => void) => () => void,
  quietMs: number,
  timers: IdleTimers = browserTimers,
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      unsubscribe();
      resolve();
    };
    const update = () => {
      if (isBusy()) {
        if (timer !== undefined) timers.clear(timer);
        timer = undefined;
      } else if (timer === undefined) {
        timer = timers.set(finish, quietMs);
      }
    };
    unsubscribe = subscribe(update);
    update();
  });
}

/** Claim installation synchronously after the final idle check. Recording
 * observes the claimed state before it starts any asynchronous native work. */
export async function claimIdleForUpdate(
  isBusy: () => boolean,
  subscribe: (listener: () => void) => () => void,
  claim: () => void,
): Promise<void> {
  do {
    await waitUntilIdle(isBusy, subscribe, 0);
  } while (isBusy());
  claim();
}
