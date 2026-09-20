import { Mic, Search } from "lucide-react";
import { PageHeader } from "@/components/shared/PageLayout.component";
import { EmptyState } from "@/components/shared/EmptyState.component";
import { HistoryStatus } from "@/components/shared/HistoryStatus.component";
import { TranscriptRow } from "@/components/shared/TranscriptRow.component";
import { TranscriptActions } from "@/components/shared/TranscriptActions.component";
import { HistorySearch } from "@/components/history/HistorySearch.component";
import { TranscriptDetail } from "@/components/history/TranscriptDetail.component";
import { useHistory } from "@/hooks/useHistory.hook";
import { useScrollMemory } from "@/hooks/useScrollMemory.hook";
import { useAppStore } from "@/store/app.store";
import { formatTriggerLabel } from "@/lib/trigger.util";
import { formatDayLabel } from "@/lib/usage.util";
import type { TranscriptRecord } from "@/types/transcript.types";

function groupByDate(
  transcripts: TranscriptRecord[],
): { date: string; items: TranscriptRecord[] }[] {
  const groups = new Map<string, TranscriptRecord[]>();
  for (const t of transcripts) {
    const dateKey = formatDayLabel(t.timestamp);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey)!.push(t);
  }
  return Array.from(groups.entries()).map(([date, items]) => ({ date, items }));
}

export function HistoryPage() {
  const {
    transcripts,
    total,
    totalMatches,
    page,
    pageSize,
    setPage,
    loading,
    error: historyError,
    retry,
    searchQuery,
    deleteTranscript,
    setSearchQuery,
    selectedTranscriptId,
    setSelectedTranscriptId,
  } = useHistory(true);
  const triggerKey = useAppStore((s) => s.triggerKey);
  const scroll = useScrollMemory(`history:${searchQuery}:${page}`, !loading);
  const groups = groupByDate(transcripts);
  const selectedTranscript = transcripts.find(
    (t) => t.transcriptId === selectedTranscriptId,
  );
  const closeDetail = () => {
    const id = selectedTranscriptId;
    setSelectedTranscriptId(null);
    requestAnimationFrame(() => {
      if (id)
        document
          .querySelector<HTMLButtonElement>(
            `[data-transcript-id="${CSS.escape(id)}"]`,
          )
          ?.focus({ preventScroll: true });
    });
  };
  const handleDeleteWithDeselect = async (transcriptId: string) => {
    await deleteTranscript(transcriptId);
    if (useAppStore.getState().selectedTranscriptId === transcriptId) {
      setSelectedTranscriptId(null);
    }
  };

  return (
    <div className="history-page">
      <div className="history-page-header">
        <PageHeader
          page="history"
          actions={
            <span className="history-count">
              {total.toLocaleString()} saved
            </span>
          }
        />
        <HistorySearch query={searchQuery} onChange={setSearchQuery} />
        {searchQuery && (
          <p className="history-search-results" role="status">
            {totalMatches.toLocaleString()}{" "}
            {totalMatches === 1 ? "result" : "results"}
          </p>
        )}
        <HistoryStatus error={historyError} loading={loading} retry={retry} />
      </div>
      <div
        className={`history-layout ${selectedTranscript ? "has-detail" : ""}`}
      >
        <div
          {...scroll}
          className="history-list"
          role="region"
          aria-label="Transcription history"
          onKeyDown={(e) => {
            const row = (e.target as HTMLElement).closest<HTMLButtonElement>(
              "[data-transcript-id]",
            );
            if (
              !row ||
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
            )
              return;
            e.preventDefault();
            const rows = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[data-transcript-id]",
              ),
            );
            const index = rows.indexOf(row);
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? rows.length - 1
                  : Math.min(
                      rows.length - 1,
                      Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)),
                    );
            rows[next]?.focus();
            if (rows[next])
              setSelectedTranscriptId(rows[next].dataset.transcriptId!);
          }}
        >
          {!loading && !historyError && total === 0 ? (
            <EmptyState
              icon={<Mic size={22} />}
              title="No transcriptions yet"
              description={`In any app, hold ${formatTriggerLabel(triggerKey)}, speak, then release. Your transcriptions will be saved here.`}
            />
          ) : !loading && !historyError && transcripts.length === 0 ? (
            <EmptyState
              icon={<Search size={22} />}
              title="No results"
              description="Try another word or application name."
              action={
                <button
                  className="standard-button"
                  onClick={() => setSearchQuery("")}
                >
                  Clear search
                </button>
              }
            />
          ) : (
            groups.map((group) => (
              <section
                className="history-day"
                key={group.date}
                aria-label={group.date}
              >
                <h2 className="history-date">
                  <span>{group.date}</span>
                  <time
                    dateTime={new Date(
                      group.items[0].timestamp,
                    ).toLocaleDateString("en-CA")}
                  >
                    {new Date(group.items[0].timestamp).toLocaleDateString([], {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                  </time>
                </h2>
                {group.items.map((t) => (
                  <TranscriptRow
                    key={t.transcriptId}
                    transcript={t}
                    presentation="history"
                    onDelete={handleDeleteWithDeselect}
                    selected={selectedTranscriptId === t.transcriptId}
                    onClick={() => setSelectedTranscriptId(t.transcriptId)}
                    actions={
                      <TranscriptActions
                        transcript={t}
                        onDelete={handleDeleteWithDeselect}
                        stopPropagation
                        menu
                      />
                    }
                  />
                ))}
              </section>
            ))
          )}
          {totalMatches > pageSize && (
            <nav className="history-pagination" aria-label="History pages">
              <button
                className="standard-button"
                disabled={loading || page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>
                Page {page + 1} of{" "}
                {Math.ceil(totalMatches / pageSize).toLocaleString()}
              </span>
              <button
                className="standard-button"
                disabled={loading || (page + 1) * pageSize >= totalMatches}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </div>
        {selectedTranscript && (
          <TranscriptDetail
            key={selectedTranscript.transcriptId}
            transcript={selectedTranscript}
            onDelete={handleDeleteWithDeselect}
            onClose={closeDetail}
          />
        )}
      </div>
    </div>
  );
}
