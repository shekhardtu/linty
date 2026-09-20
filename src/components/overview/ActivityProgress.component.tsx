import type { UsageSummary } from "@/types/history.types";

export function ActivityProgress({
  activeDays,
  comparison,
  comparisonDays,
}: {
  activeDays: number;
  comparison: UsageSummary | null;
  comparisonDays: number | null;
}) {
  const difference = comparison ? activeDays - comparison.activeDays : null;
  const detail =
    difference === null
      ? "From your saved history"
      : difference === 0
        ? `Same as the previous ${comparisonDays} days`
        : `${Math.abs(difference)} ${difference > 0 ? "more" : "fewer"} than the previous ${comparisonDays} days`;
  return (
    <p className="activity-progress">
      <strong>
        {activeDays.toLocaleString()} active {activeDays === 1 ? "day" : "days"}
      </strong>
      <span> · {detail}</span>
    </p>
  );
}
