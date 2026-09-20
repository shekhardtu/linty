import { HistoryStatus } from "@/components/shared/HistoryStatus.component";
import { ChevronDown } from "lucide-react";
import { useUsagePeriod } from "@/hooks/useUsagePeriod.hook";
import { UsagePeriodControl } from "@/components/shared/UsagePeriodControl.component";
import { HistoryScopeNote } from "@/components/shared/HistoryScopeNote.component";

export function ProcessingDetails() {
  const {
    engines: rows,
    period,
    setPeriod,
    loading,
    error,
    retry,
  } = useUsagePeriod();
  return (
    <details className="processing-details">
      <summary>
        <span>Processing details</span>
        <ChevronDown size={15} />
      </summary>
      <div className="processing-details-content">
        <HistoryStatus loading={loading} error={error} retry={retry} />
        <div className="processing-period">
          <p>How your saved dictations were processed.</p>
          <UsagePeriodControl value={period} onChange={setPeriod} />
        </div>
        <div className="app-table-scroll">
          <table className="app-usage-table">
            <caption className="sr-only">Processing by speech engine</caption>
            <thead>
              <tr>
                <th>Engine</th>
                <th>Dictations</th>
                <th>Share</th>
                <th>Corrections / 100 words</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.engine}>
                  <th scope="row">
                    {row.engine === "local" ? "On-device" : "Previous version"}
                  </th>
                  <td>{row.sessions.toLocaleString()}</td>
                  <td>{row.share === null ? "—" : `${row.share}%`}</td>
                  <td>{row.rate === null ? "—" : row.rate.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="preferences-footnote">
          Corrections reflect the fixes you make in saved transcriptions.
        </p>
        <HistoryScopeNote />
      </div>
    </details>
  );
}
