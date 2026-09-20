import { useAppStore } from "@/store/app.store";
import { refreshHistory } from "@/services/history.service";

export function HistoryStatus({
  error,
  loading = false,
  retry,
}: {
  error?: string | null;
  loading?: boolean;
  retry?: () => void;
}) {
  const historyError = useAppStore((s) => s.historyError);
  const message = error || historyError;
  if (message)
    return (
      <div className="history-storage-status" role="alert">
        <span>Could not load saved history. {message}</span>
        <button
          className="text-link"
          onClick={() =>
            void refreshHistory()
              .catch(() => {})
              .finally(() => retry?.())
          }
        >
          Retry
        </button>
      </div>
    );
  return loading ? (
    <p className="sr-only" role="status">
      Loading saved history…
    </p>
  ) : null;
}
