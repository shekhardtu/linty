import { Select } from "@/components/shared/Select.component";
import { useMemo } from "react";
import type { ApplicationSort } from "@/store/slices/workspace.slice";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { HistoryStatus } from "@/components/shared/HistoryStatus.component";
import { useHistory } from "@/hooks/useHistory.hook";
import { useAppStore } from "@/store/app.store";
import { AppIcon } from "@/components/shared/AppIcon.component";
import { ApplicationShare } from "@/components/apps/ApplicationShare.component";
import {
  PageHeader,
  PageLayout,
} from "@/components/shared/PageLayout.component";
import { useAppIcons } from "@/hooks/useAppIcons.hook";
import { useUsagePeriod } from "@/hooks/useUsagePeriod.hook";
import { UsagePeriodControl } from "@/components/shared/UsagePeriodControl.component";
import { HistoryScopeNote } from "@/components/shared/HistoryScopeNote.component";
import {
  formatDayLabel,
  formatDuration,
  type ApplicationUsage,
} from "@/lib/usage.util";

const number = (value: number) => value.toLocaleString();

const SORT_OPTIONS: { value: ApplicationSort; label: string }[] = [
  { value: "words", label: "Words" },
  { value: "seconds", label: "Dictation time" },
  { value: "sessions", label: "Sessions" },
  { value: "lastUsedAt", label: "Last used" },
];

/** Per-application dictation statistics for the selected period. */
export function AppsPage() {
  const { total, setSearchQuery } = useHistory();
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const tracking = useAppStore((s) => s.trackApplicationUsage);
  const sort = useAppStore((s) => s.applicationSort);
  const setSort = useAppStore((s) => s.setApplicationSort);
  const {
    period,
    setPeriod,
    asOf,
    stats,
    applications,
    loading,
    error,
    retry,
  } = useUsagePeriod("apps");
  const apps = useMemo(
    () =>
      [...applications].sort(
        (a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name),
      ),
    [applications, sort],
  );
  const attributed = apps.filter((app) => app.attributed);
  const icons = useAppIcons(attributed.map((app) => app.bundleId));
  const attributedWords = attributed.reduce((sum, app) => sum + app.words, 0);
  const topApp = [...attributed].sort((a, b) => b.words - a.words)[0];
  const hasHistory = total > 0;
  const openHistory = (query: string) => {
    setSearchQuery(query);
    setCurrentView("history");
  };
  const share = (app: ApplicationUsage) =>
    stats.words ? Math.round((app.words / stats.words) * 100) : 0;

  return (
    <PageLayout className="apps-page" ready={!loading}>
      <PageHeader
        page="apps"
        actions={<UsagePeriodControl value={period} onChange={setPeriod} />}
      />

      <HistoryStatus loading={loading} error={error} retry={retry} />
      <section
        className="apps-summary"
        aria-label="Application usage summary"
        aria-busy={loading}
      >
        <div className="apps-most-used">
          <span className="eyebrow">Most used</span>
          <div className="apps-lead-value" title={topApp?.name}>
            {topApp?.name ?? "—"}
          </div>
          <p>
            {topApp
              ? `${share(topApp)}% of your words`
              : "Your most used app will appear here"}
          </p>
        </div>
        <div className="apps-summary-metric">
          <div className="apps-summary-value">{number(stats.words)}</div>
          <p>
            words across {number(apps.length)} app{" "}
            {apps.length === 1 ? "group" : "groups"}
          </p>
        </div>
        <div className="apps-summary-metric">
          <div className="apps-summary-value">
            {formatDuration(stats.seconds)}
          </div>
          <p>
            time dictating
            {stats.words === attributedWords ? " in apps" : " in this period"}
          </p>
        </div>
      </section>
      <ApplicationShare applications={applications} totalWords={stats.words} />

      <section
        className="applications-section"
        aria-labelledby="all-apps-heading"
      >
        <div className="section-heading">
          <div>
            <h2 id="all-apps-heading">All apps</h2>
          </div>
          <div className="sort-control">
            <span>Sort by</span>
            <Select<ApplicationSort>
              label="Sort applications"
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
            />
          </div>
        </div>
        {apps.length > 0 ? (
          <div className="app-table-scroll">
            <table className="app-usage-table">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Words</th>
                  <th>Time</th>
                  <th>Sessions</th>
                  <th>Words / session</th>
                  <th>Avg. length</th>
                  <th>Turnaround</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id}>
                    <td>
                      <button
                        className="app-name"
                        disabled={!app.attributed}
                        onClick={() => openHistory(app.name)}
                        title={
                          app.attributed
                            ? `View ${app.name} transcripts`
                            : "Older sessions or app attribution unavailable"
                        }
                      >
                        <AppIcon
                          name={app.attributed ? app.name : "?"}
                          icon={app.bundleId ? icons[app.bundleId] : null}
                          size="sm"
                        />
                        <span className="min-w-0">
                          <strong>{app.name}</strong>
                        </span>
                      </button>
                    </td>
                    <td
                      className="app-word-count"
                      title={`${share(app)}% of all words`}
                    >
                      {number(app.words)}
                    </td>
                    <td title={`${(app.seconds / 3600).toFixed(3)} hours`}>
                      {formatDuration(app.seconds)}
                    </td>
                    <td>{number(app.sessions)}</td>
                    <td>{number(Math.round(app.words / app.sessions))}</td>
                    <td>{formatDuration(app.seconds / app.sessions)}</td>
                    <td
                      title={`${app.local} of ${app.sessions} processed on-device`}
                    >
                      {(app.processingMs / app.sessions / 1000).toFixed(1)}s
                    </td>
                    <td>{formatDayLabel(app.lastUsedAt, asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="app-empty">
            <h3>
              {!hasHistory
                ? "No dictations yet"
                : tracking
                  ? "No app activity in this period"
                  : "App attribution is paused"}
            </h3>
            <p>
              {!hasHistory
                ? "Dictate in your favorite apps to see their words, time, and sessions here."
                : tracking
                  ? "Try a wider time range, or dictate in an app to start tracking it."
                  : "Turn on app attribution in Settings → Privacy & Storage for new dictations."}
            </p>
            {hasHistory && !tracking && (
              <button
                className="text-link mt-3"
                onClick={() => setSettingsSection("privacy")}
              >
                Open privacy settings
              </button>
            )}
          </div>
        )}
      </section>
      <div className="apps-privacy-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <div>
          <p>App attribution is {tracking ? "on" : "paused"}.</p>
          <p>
            {tracking
              ? "Application names stay in your saved history on this Mac."
              : "New dictations won’t include an application name. Saved app activity stays on this Mac."}
          </p>
          {stats.words > attributedWords && (
            <p>
              {number(stats.words - attributedWords)} words have no app
              attribution.
            </p>
          )}
        </div>
        <button
          className="text-link"
          onClick={() => setSettingsSection("privacy")}
        >
          Privacy settings <ArrowRight size={13} />
        </button>
      </div>

      <HistoryScopeNote />
    </PageLayout>
  );
}
