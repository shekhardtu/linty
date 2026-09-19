import { useEffect, useCallback, useState } from "react";
import { useAppStore } from "@/store/app.store";
import {
  initializeHistory,
  removeTranscript,
  restoreTranscript,
  clearHistory,
  queryHistory,
  HISTORY_PAGE_SIZE,
} from "@/services/history.service";
import type { HistoryPageResult } from "@/types/history.types";

export function useHistory(paginated = false) {
  const snapshot = useAppStore((s) => s.historySnapshot);
  const cacheEpoch = useAppStore((s) => s.historyCacheEpoch);
  const recent = useAppStore((s) => s.transcripts);
  const loaded = useAppStore((s) => s.historyLoaded);
  const loadError = useAppStore((s) => s.historyError);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const selectedTranscriptId = useAppStore((s) => s.selectedTranscriptId);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSelectedTranscriptId = useAppStore((s) => s.setSelectedTranscriptId);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<HistoryPageResult>({
    records: [],
    total: 0,
  });
  const [resultEpoch, setResultEpoch] = useState(cacheEpoch);
  useEffect(() => {
    setResult({ records: [], total: 0 });
  }, [cacheEpoch]);
  const [loading, setLoading] = useState(paginated);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // A changed query starts at page one, including before the effect resets page state.
  const [pageQuery, setPageQuery] = useState(searchQuery);
  const currentPage = pageQuery === searchQuery ? page : 0;
  useEffect(() => {
    setPage(0);
    setPageQuery(searchQuery);
    setSelectedTranscriptId(null);
  }, [searchQuery, setSelectedTranscriptId]);
  useEffect(() => {
    void initializeHistory().catch(() => {});
  }, []);
  useEffect(() => {
    if (!paginated) return;
    let stale = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(
      () => {
        queryHistory(searchQuery, currentPage * HISTORY_PAGE_SIZE)
          .then((data) => {
            if (stale || cacheEpoch !== useAppStore.getState().historyCacheEpoch) return;
            const lastPage = Math.max(
              0,
              Math.ceil(data.total / HISTORY_PAGE_SIZE) - 1,
            );
            if (currentPage > lastPage) {
              setPage(lastPage);
              return;
            }
            setResult(data);
            setResultEpoch(cacheEpoch);
            setLoading(false);
          })
          .catch((e) => {
            if (!stale) {
              setError(String(e));
              setLoading(false);
            }
          });
      },
      searchQuery ? 150 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [paginated, searchQuery, currentPage, snapshot.revision, retry, cacheEpoch]);
  const deleteTranscript = useCallback(async (id: string) => {
    const deleted = await removeTranscript(id);
    if (!deleted) return;
    let restored = false;
    useAppStore.getState().addToast({
      type: "success",
      message: deleted.transcript.audio ? "Transcript and audio deleted. Undo restores text only." : "Transcript deleted",
      action: {
        label: "Undo",
        onClick: async function undoTranscript() {
          if (restored) return;
          restored = true;
          try {
            await restoreTranscript(deleted);
            const state = useAppStore.getState();
            state.toasts
              .filter((t) => t.action?.onClick === undoTranscript)
              .forEach((t) => state.removeToast(t.toastId));
            state.addToast({ type: "success", message: "Transcript restored" });
          } catch {
            restored = false;
            useAppStore
              .getState()
              .addToast({
                type: "error",
                message: "Could not restore transcript. Try Undo again.",
              });
          }
        },
      },
    });
  }, []);
  return {
    transcripts: paginated ? (resultEpoch === cacheEpoch ? result.records : []) : recent,
    total: snapshot.total,
    totalMatches: paginated ? (resultEpoch === cacheEpoch ? result.total : 0) : snapshot.total,
    page: currentPage,
    pageSize: HISTORY_PAGE_SIZE,
    setPage: (next: number) => {
      setSelectedTranscriptId(null);
      setPage(next);
    },
    loading: paginated ? loading : !loaded,
    error: error || loadError,
    retry: () => {
      void initializeHistory().catch(() => {});
      setRetry((n) => n + 1);
    },
    searchQuery,
    selectedTranscriptId,
    setSearchQuery,
    setSelectedTranscriptId,
    deleteTranscript,
    clearAll: clearHistory,
  };
}
