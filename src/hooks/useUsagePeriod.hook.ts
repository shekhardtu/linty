import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";
import { initializeHistory } from "@/services/history.service";
import {
  periodStart,
  summarizeUsage,
  usageBuckets,
} from "@/lib/usage.util";
import type { UsageView } from "@/store/slices/workspace.slice";
import { canCompareHistory, previousUsageWindow } from "@/lib/payoff.util";
import type { UsageResult, UsageSummary } from "@/types/history.types";

const EMPTY: UsageResult = {
  stats: summarizeUsage([]),
  timing: {
    words: 0,
    seconds: 0,
    processingSeconds: 0,
    sessions: 0,
    missingSessions: 0,
  },
  activeDays: 0,
  applications: [],
  timeline: [],
  recent: [],
  engines: ["local"].map((engine) => ({
    engine,
    sessions: 0,
    share: null,
    rate: null,
  })),
};
/** All metrics query the complete local archive with the same period boundaries. */
export function useUsagePeriod(view: UsageView = "dashboard") {
  const period = useAppStore((s) => s.usagePeriods[view]);
  const setUsagePeriod = useAppStore((s) => s.setUsagePeriod);
  const [now, setNow] = useState(Date.now);
  const snapshot = useAppStore((s) => s.historySnapshot);
  const cacheEpoch = useAppStore((s) => s.historyCacheEpoch);
  const [resultEpoch, setResultEpoch] = useState(cacheEpoch);
  const [data, setData] = useState<
    UsageResult & {
      comparison: UsageSummary | null;
      comparisonDays: number | null;
    }
  >({ ...EMPTY, comparison: null, comparisonDays: null });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setData({ ...EMPTY, comparison: null, comparisonDays: null });
  }, [cacheEpoch]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let stale = false;
    const asOf = Math.max(now, Date.now());
    setLoading(true);
    setError(null);
    initializeHistory()
      .then(async () => {
        const { oldestTimestamp, retentionDays } =
          useAppStore.getState().historySnapshot;
        const prior = previousUsageWindow(period, asOf);
        const compare =
          prior &&
          canCompareHistory(oldestTimestamp, retentionDays, prior.start, asOf);
        const [usage, comparison] = await Promise.all([
          invoke<UsageResult>("history_usage", {
            start: period === "all" ? 0 : periodStart(period, asOf),
            end: asOf,
            buckets: usageBuckets(oldestTimestamp, period, asOf),
          }),
          compare
            ? invoke<UsageSummary>("history_usage_summary", {
                start: prior.start,
                end: prior.end,
              })
            : Promise.resolve(null),
        ]);
        return { ...usage, comparison, comparisonDays: prior?.days ?? null };
      })
      .then((result) => {
        if (!stale && cacheEpoch === useAppStore.getState().historyCacheEpoch) {
          setData(result);
          setResultEpoch(cacheEpoch);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!stale) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
    };
  }, [period, now, snapshot.revision, retry, cacheEpoch]);
  return {
    ...(resultEpoch === cacheEpoch ? data : { ...EMPTY, comparison: null, comparisonDays: null }),
    period,
    setPeriod: (nextPeriod: typeof period) => setUsagePeriod(view, nextPeriod),
    asOf: now,
    loading,
    error,
    retry: () => setRetry((n) => n + 1),
  };
}
