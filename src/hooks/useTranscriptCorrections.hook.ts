import { useEffect, useState } from "react";
import { useAppStore } from "@/store/app.store";
import { getCorrections } from "@/services/history.service";
import type { CorrectionRecord } from "@/types/correction.types";

/** Keep the reading pane and Details in sync with saved and observed corrections. */
export function useTranscriptCorrections(transcriptId: string) {
  const revision = useAppStore((s) => s.historySnapshot.revision);
  const cacheEpoch = useAppStore((s) => s.historyCacheEpoch);
  const [corrections, setCorrections] = useState<CorrectionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setCorrections([]); }, [cacheEpoch]);

  useEffect(() => {
    let stale = false;
    setError(false);
    setLoaded(false);
    void getCorrections(transcriptId)
      .then((records) => {
        if (stale || cacheEpoch !== useAppStore.getState().historyCacheEpoch) return;
        setCorrections(records.filter((record) => record.pairs.length > 0)
          .sort((a, b) => b.timestamp - a.timestamp));
        setLoaded(true);
      })
      .catch(() => {
        if (stale) return;
        setError(true);
        setLoaded(true);
      });
    return () => { stale = true; };
  }, [transcriptId, revision, attempt, cacheEpoch]);

  return { corrections, loaded, error, retry: () => setAttempt((n) => n + 1) };
}
