import { ArrowRight } from "lucide-react";
import { HistoryStatus } from "@/components/shared/HistoryStatus.component";
import { useHistory } from "@/hooks/useHistory.hook";
import { useUsagePeriod } from "@/hooks/useUsagePeriod.hook";
import { useAppStore } from "@/store/app.store";
import { AppIcon } from "@/components/shared/AppIcon.component";
import { PayoffSummary } from "@/components/overview/PayoffSummary.component";
import { ActivityProgress } from "@/components/overview/ActivityProgress.component";
import {
  PageHeader,
  PageLayout,
  SectionHeading,
} from "@/components/shared/PageLayout.component";
import { UsagePeriodControl } from "@/components/shared/UsagePeriodControl.component";
import { HistoryScopeNote } from "@/components/shared/HistoryScopeNote.component";
import { UsageChart } from "@/components/shared/UsageChart.component";
import { OverviewWidgets } from "@/components/overview/OverviewWidgets.component";
import { BrandMark } from "@/components/shared/BrandMark.component";
import { useAppIcons } from "@/hooks/useAppIcons.hook";
import { TranscriptRow } from "@/components/shared/TranscriptRow.component";
import { TranscriptActions } from "@/components/shared/TranscriptActions.component";
import { formatTriggerLabel } from "@/lib/trigger.util";

const number = (value: number) => value.toLocaleString();

export function DashboardPage() {
  const { total, deleteTranscript, setSearchQuery } = useHistory();
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const triggerKey = useAppStore((s) => s.triggerKey);
  const tracking = useAppStore((s) => s.trackApplicationUsage);
  const usage = useUsagePeriod();
  const {
    period,
    setPeriod,
    recent,
    stats,
    applications,
    timeline,
    loading,
    error,
    retry,
  } = usage;
  const topApps = applications
    .filter((app) => app.attributed)
    .sort((a, b) => b.words - a.words || a.name.localeCompare(b.name))
    .slice(0, 3);
  const appIcons = useAppIcons(topApps.map((app) => app.bundleId));
  const hasHistory = total > 0;
  const openHistory = (query = "") => {
    setSearchQuery(query);
    setCurrentView("history");
  };

  return (
    <PageLayout className="overview-page" ready={!loading}>
      <PageHeader
        page="dashboard"
        description={null}
        editorial
        actions={<UsagePeriodControl value={period} onChange={setPeriod} />}
      />
      {!loading && !error && !hasHistory && (
        <div className="first-dictation-banner animate-slide-up">
          <BrandMark />
          <div className="flex-1">
            <h2>Ready for your first dictation</h2>
            <p>
              Open an app, hold <kbd>{formatTriggerLabel(triggerKey)}</kbd>,
              speak, then release to paste your words.
            </p>
          </div>
          <button
            className="text-link"
            onClick={() => setCurrentView("system-check")}
          >
            Check setup <ArrowRight size={14} />
          </button>
        </div>
      )}
      <HistoryStatus loading={loading} error={error} retry={retry} />
      <div className="editorial-columns" aria-busy={loading}>
        <div className="overview-reading-column">
          <PayoffSummary
            summary={usage}
            comparison={usage.comparison}
            comparisonDays={usage.comparisonDays}
          />
          <section className="overview-transcripts">
            <SectionHeading
              title="Recent transcriptions"
              actions={
                <button className="text-link" onClick={() => openHistory()}>
                  View history <ArrowRight size={13} />
                </button>
              }
            />
            {recent.length ? (
              recent
                .slice(0, 5)
                .map((t) => (
                  <TranscriptRow
                    key={t.transcriptId}
                    transcript={t}
                    copyOnClick
                    onDelete={deleteTranscript}
                    actions={
                      <TranscriptActions
                        transcript={t}
                        onDelete={deleteTranscript}
                      />
                    }
                  />
                ))
            ) : (
              <p className="section-empty">
                {hasHistory
                  ? "No dictations in this period. Try a wider time range."
                  : "Your completed dictations will appear here."}
              </p>
            )}
          </section>
        </div>
        <aside
          className="overview-support"
          aria-label="Activity and useful details"
        >
          <section className="overview-activity">
            <SectionHeading
              title="Dictation activity"
              actions={
                <span className="metric-pill">
                  {period === "all" ? "Words over time" : "Words / day"}
                </span>
              }
            />
            <UsageChart timeline={timeline} hasHistory={hasHistory} />
            <ActivityProgress
              activeDays={usage.activeDays}
              comparison={usage.comparison}
              comparisonDays={usage.comparisonDays}
            />
          </section>
          <div className="overview-support-details">
            <section className="overview-apps">
              <SectionHeading
                title="Dictation by app"
                actions={
                  <button
                    className="text-link"
                    onClick={() => setCurrentView("apps")}
                  >
                    View all apps <ArrowRight size={13} />
                  </button>
                }
              />
              {topApps.length > 0 ? (
                <div className="app-table-scroll">
                  <table className="app-usage-table overview-app-table">
                    <thead>
                      <tr>
                        <th>Application</th>
                        <th>Words</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topApps.map((app) => {
                        const share = stats.words
                          ? Math.round((app.words / stats.words) * 100)
                          : 0;
                        return (
                          <tr key={app.id}>
                            <td>
                              <button
                                className="app-name"
                                onClick={() => openHistory(app.name)}
                                title={`View ${app.name} transcripts`}
                              >
                                <AppIcon
                                  name={app.name}
                                  icon={
                                    app.bundleId ? appIcons[app.bundleId] : null
                                  }
                                />
                                <strong className="min-w-0">{app.name}</strong>
                              </button>
                            </td>
                            <td>
                              <strong className="font-semibold">
                                {number(app.words)}
                              </strong>
                              <div className="overview-app-share">
                                <span
                                  className="app-share-track"
                                  aria-hidden="true"
                                >
                                  <span style={{ width: `${share}%` }} />
                                </span>
                                <span>
                                  <span className="sr-only">
                                    Share of all words:{" "}
                                  </span>
                                  {share}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="app-empty">
                  <h3>
                    {tracking
                      ? "No app activity yet"
                      : "App attribution is paused"}
                  </h3>
                  <p>
                    {tracking
                      ? "Dictate in your favorite apps to see where your words go."
                      : "Turn on app attribution in Settings → Privacy & Storage for new dictations."}
                  </p>
                </div>
              )}
            </section>
            <OverviewWidgets />
            <HistoryScopeNote />
          </div>
        </aside>
      </div>
    </PageLayout>
  );
}
