import {
  applicationShareSegments,
  type ApplicationUsage,
} from "@/lib/usage.util";

const percentage = (value: number) =>
  value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;

export function ApplicationShare({
  applications,
  totalWords,
}: {
  applications: ApplicationUsage[];
  totalWords: number;
}) {
  const segments = applicationShareSegments(applications, totalWords);
  if (!segments.length) return null;
  return (
    <section
      className="application-share"
      aria-label="Word distribution by application"
    >
      <div
        className="app-share-bar"
        role="img"
        aria-label={`Share of all words by app: ${segments.map((segment) => `${segment.name} ${percentage(segment.share)}`).join(", ")}`}
      >
        {segments.map((segment) => (
          <span
            key={segment.id}
            data-share-tone={segment.tone}
            style={{ flexGrow: segment.words }}
            title={`${segment.name}: ${segment.words.toLocaleString()} words (${percentage(segment.share)})`}
          />
        ))}
      </div>
      <ul className="app-share-legend" aria-hidden="true">
        {segments.map((segment) => (
          <li key={segment.id} data-share-tone={segment.tone}>
            <i />
            {segment.name} <span>{percentage(segment.share)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
