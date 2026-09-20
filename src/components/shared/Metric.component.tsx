import { cn } from "@/lib/utils";

/** Typography supplies hierarchy; a metric does not need an enclosing surface. */
export function Metric({
  value,
  label,
  detail,
  lead = false,
}: {
  value: string;
  label: string;
  detail?: string;
  lead?: boolean;
}) {
  return (
    <div className={cn("metric", lead && "metric-lead")}>
      <span className="metric-label">{label}</span>
      <div className="metric-value">{value}</div>
      {detail && <p>{detail}</p>}
    </div>
  );
}
