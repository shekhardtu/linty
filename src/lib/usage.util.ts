import type { TranscriptRecord } from "../types/transcript.types";

export type UsagePeriod = "7d" | "30d" | "all";

export function periodStart(period: UsagePeriod, now: number): number {
  if (period === "all") return -Infinity;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (period === "7d" ? 6 : 29));
  return start.getTime();
}

export function filterByPeriod(
  records: TranscriptRecord[],
  period: UsagePeriod,
  now: number,
) {
  const start = periodStart(period, now);
  return records.filter((t) => t.timestamp >= start && t.timestamp <= now);
}

export function summarizeUsage(records: TranscriptRecord[]) {
  const words = records.reduce((sum, t) => sum + t.wordCount, 0);
  const seconds = records.reduce((sum, t) => sum + t.durationSeconds, 0);
  const processingMs = records.reduce((sum, t) => sum + t.processingTimeMs, 0);
  const local = records.filter((t) => t.engine === "local").length;
  return {
    words,
    seconds,
    sessions: records.length,
    local,
    avgProcessingSeconds: records.length
      ? processingMs / records.length / 1000
      : 0,
    wordsPerMinute: seconds > 0 ? Math.round((words / seconds) * 60) : 0,
    localPercent: records.length
      ? Math.round((local / records.length) * 100)
      : 0,
  };
}

export interface ApplicationUsage {
  id: string;
  name: string;
  /** Bundle identifier when known; used to look up the app icon. */
  bundleId: string | null;
  attributed: boolean;
  words: number;
  seconds: number;
  sessions: number;
  /** Timestamp of the most recent dictation in this app. */
  lastUsedAt: number;
  /** Total speech-to-paste processing time, for per-app turnaround. */
  processingMs: number;
  /** Dictations processed on-device. */
  local: number;
}

export function usageByApplication(
  records: TranscriptRecord[],
): ApplicationUsage[] {
  const apps = new Map<string, ApplicationUsage>();
  for (const t of records) {
    const id = t.application
      ? t.application.bundleId
        ? `bundle:${t.application.bundleId}`
        : `name:${t.application.name}`
      : "unattributed";
    const app = apps.get(id) ?? {
      id,
      name: t.application?.name ?? "Unattributed",
      bundleId: t.application?.bundleId ?? null,
      attributed: !!t.application,
      words: 0,
      seconds: 0,
      sessions: 0,
      lastUsedAt: 0,
      processingMs: 0,
      local: 0,
    };
    app.words += t.wordCount;
    app.seconds += t.durationSeconds;
    app.sessions++;
    app.lastUsedAt = Math.max(app.lastUsedAt, t.timestamp);
    app.processingMs += t.processingTimeMs;
    if (t.engine === "local") app.local++;
    apps.set(id, app);
  }
  return [...apps.values()];
}

export interface ApplicationShareSegment {
  id: string;
  name: string;
  words: number;
  share: number;
  tone: "accent" | "chart" | "secondary" | "other" | "unattributed";
}

/** The leading three apps, remaining apps, and unattributed words share one denominator. */
export function applicationShareSegments(
  applications: ApplicationUsage[],
  totalWords: number,
): ApplicationShareSegment[] {
  if (totalWords <= 0) return [];
  const ranked = applications
    .filter((app) => app.attributed && app.words > 0)
    .sort((a, b) => b.words - a.words || a.name.localeCompare(b.name));
  const tones = ["accent", "chart", "secondary"] as const;
  const segments: ApplicationShareSegment[] = ranked
    .slice(0, 3)
    .map((app, index) => ({
      id: app.id,
      name: app.name,
      words: app.words,
      share: (app.words / totalWords) * 100,
      tone: tones[index],
    }));
  const otherWords = ranked.slice(3).reduce((sum, app) => sum + app.words, 0);
  const unattributedWords = applications
    .filter((app) => !app.attributed)
    .reduce((sum, app) => sum + app.words, 0);
  if (otherWords > 0)
    segments.push({
      id: "other",
      name: "Other apps",
      words: otherWords,
      share: (otherWords / totalWords) * 100,
      tone: "other",
    });
  if (unattributedWords > 0)
    segments.push({
      id: "unattributed",
      name: "Unattributed",
      words: unattributedWords,
      share: (unattributedWords / totalWords) * 100,
      tone: "unattributed",
    });
  return segments;
}

/** "Today", "Yesterday", or a short calendar date in local time. */
export function formatDayLabel(timestamp: number, now = Date.now()) {
  const date = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

/** Calendar boundaries are generated in the user's time zone, including DST. */
export function usageBuckets(
  oldestTimestamp: number | null,
  period: UsagePeriod,
  now: number,
) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(
    period === "all"
      ? Math.min(now, oldestTimestamp ?? now)
      : periodStart(period, now),
  );
  start.setHours(0, 0, 0, 0);
  const monthly =
    period === "all" && end.getTime() - start.getTime() > 31 * 86400000;
  if (monthly) start.setDate(1);
  const buckets = [];
  for (const cursor = new Date(start); cursor <= end;) {
    const next = new Date(cursor);
    if (monthly) next.setMonth(next.getMonth() + 1);
    else next.setDate(next.getDate() + 1);
    buckets.push({
      timestamp: cursor.getTime(),
      end: next.getTime(),
      label: cursor.toLocaleDateString(
        [],
        monthly
          ? { month: "short", year: "2-digit" }
          : period === "7d"
            ? { weekday: "short" }
            : { day: "numeric", month: "short" },
      ),
      fullLabel: cursor.toLocaleDateString(
        [],
        monthly
          ? { month: "long", year: "numeric" }
          : { month: "short", day: "numeric", year: "numeric" },
      ),
    });
    cursor.setTime(next.getTime());
  }
  return buckets;
}

export function usageTimeline(
  records: TranscriptRecord[],
  period: UsagePeriod,
  now: number,
) {
  const oldest = records.reduce(
    (oldest, record) => Math.min(oldest, record.timestamp),
    now,
  );
  return usageBuckets(oldest, period, now).map(({ end, ...bucket }) => {
    const entries = records.filter(
      (t) => t.timestamp >= bucket.timestamp && t.timestamp < end,
    );
    return {
      ...bucket,
      words: entries.reduce((sum, t) => sum + t.wordCount, 0),
      sessions: entries.length,
    };
  });
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
