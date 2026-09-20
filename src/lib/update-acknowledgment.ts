import { compareVersions, isVersion, normalizeVersion } from "./force-update.util.ts";

export interface UpdateNotice {
  version: string;
  kind: "updated" | "whats-new";
}

export interface UpdateHistory {
  lastRunVersion: string;
  notice: UpdateNotice | null;
}

/** Compare the running binary, never an offered or downloaded update. */
export function reconcileUpdateHistory(saved: unknown, runningVersion: string, returningCustomer: boolean): UpdateHistory {
  if (!isVersion(runningVersion)) throw new Error("Cannot identify the installed Linty version");
  const version = normalizeVersion(runningVersion);
  const history = saved as Partial<UpdateHistory> | null | undefined;
  const previous = history?.lastRunVersion;
  let notice: UpdateNotice | null = null;

  if (isVersion(previous)) {
    const direction = compareVersions(version, previous);
    if (direction > 0) notice = { version, kind: "updated" };
    else if (direction === 0 && history?.notice?.version === version
      && ["updated", "whats-new"].includes(history.notice.kind)) {
      notice = history.notice;
    }
    // Downgrades establish a new baseline without claiming an update succeeded.
  } else if (returningCustomer) {
    // Older installations have no version baseline. Welcome them to the notes
    // without claiming we observed an upgrade. Fresh installs stay quiet.
    notice = { version, kind: "whats-new" };
  }
  return { lastRunVersion: version, notice };
}

export function releaseHighlights(notes: string | null | undefined): string[] {
  if (!notes?.trim() || /^(?:Linty\s+)?v?\d+\.\d+\.\d+\s*$/i.test(notes.trim())) return [];
  return notes.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.replace(/^[-*]\s+/, ""));
}
