import { SegmentedControl } from "./SegmentedControl.component";
import type { UsagePeriod } from "@/lib/usage.util";

const PERIODS: { value: UsagePeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

export function UsagePeriodControl({
  value,
  onChange,
}: {
  value: UsagePeriod;
  onChange: (period: UsagePeriod) => void;
}) {
  return (
    <SegmentedControl
      label="Usage period"
      className="period-control"
      segments={PERIODS}
      value={value}
      onChange={onChange}
    />
  );
}
