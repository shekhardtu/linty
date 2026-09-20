import { useAppStore } from "@/store/app.store";

export function HistoryScopeNote() {
  const retention = useAppStore((s) => s.historySnapshot.retentionDays);
  return (
    <p className="dashboard-footnote">
      <span>
        {retention
          ? `Based on retained history with a ${retention}-day retention period.`
          : "Based on all your saved transcriptions."}
      </span>{" "}
      <span>Deleting history also removes its statistics.</span>
    </p>
  );
}
