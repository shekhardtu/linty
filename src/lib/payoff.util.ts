import type { UsageTiming } from "../types/history.types";
import { periodStart, type UsagePeriod } from "./usage.util.ts";

// A disclosed assumption, not a population average or a measured typing speed.
export const DEFAULT_TYPING_SPEED = 40;
export const MIN_TYPING_SPEED = 10;
export const MAX_TYPING_SPEED = 200;
export function validTypingSpeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TYPING_SPEED &&
    value <= MAX_TYPING_SPEED
  );
}
export function typingSpeed(value: unknown) {
  return validTypingSpeed(value) ? value : DEFAULT_TYPING_SPEED;
}
export function estimatePayoff(timing: UsageTiming, baseline: number) {
  if (
    !timing.sessions ||
    timing.words <= 0 ||
    timing.seconds <= 0 ||
    timing.processingSeconds <= 0
  )
    return null;
  const typingSeconds = (timing.words / typingSpeed(baseline)) * 60;
  const actualSeconds = timing.seconds + timing.processingSeconds;
  return {
    typingSeconds,
    savedSeconds: typingSeconds - actualSeconds,
    speedRatio: typingSeconds / actualSeconds,
    wordsPerMinute: (timing.words / timing.seconds) * 60,
  };
}
export function formatEstimatedTime(seconds: number) {
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (!minutes) return "<1m";
  return minutes >= 60
    ? `${Math.floor(minutes / 60).toLocaleString()}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}
/** Compare matching local-calendar windows through the same time of day, including DST. */
export function previousUsageWindow(period: UsagePeriod, now: number) {
  if (period === "all") return null;
  const days = period === "7d" ? 7 : 30;
  const previousEnd = new Date(now);
  previousEnd.setDate(previousEnd.getDate() - days);
  const start = new Date(periodStart(period, now));
  start.setDate(start.getDate() - days);
  return { start: start.getTime(), end: previousEnd.getTime(), days };
}
export function canCompareHistory(
  oldest: number | null,
  retentionDays: number,
  start: number,
  now: number,
) {
  return (
    oldest !== null &&
    oldest <= start &&
    (!retentionDays || now - retentionDays * 86400000 <= start)
  );
}
/** Sparse periods do not warrant a percentage claim. */
export function paceChange(current: UsageTiming, previous: UsageTiming | null) {
  if (
    !previous ||
    current.sessions < 3 ||
    previous.sessions < 3 ||
    current.seconds < 60 ||
    previous.seconds < 60 ||
    !previous.words
  )
    return null;
  return Math.round(
    (current.words / current.seconds / (previous.words / previous.seconds) -
      1) *
      100,
  );
}
