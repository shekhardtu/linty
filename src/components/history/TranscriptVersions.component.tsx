import { ChevronDown } from "lucide-react";
import type { TranscriptRecord } from "@/types/transcript.types";

/** Keep every stored stage available, showing identical text only once. */
export function TranscriptVersions({ transcript }: { transcript: TranscriptRecord }) {
  const snapshots = [
    { label: "Original transcription", text: transcript.rawText },
    { label: "Reformatted by S1-mini", text: transcript.reformattedText },
    { label: transcript.deliveryStatus === "verified" ? "Confirmed inserted text" : "Pasted text", text: transcript.pastedText },
    { label: "Text sent for pasting", text: transcript.pastedText == null ? transcript.attemptedText : undefined },
  ];
  const versions: { labels: string[]; text: string }[] = [];
  for (const { label, text } of snapshots) {
    if (text == null) continue;
    const existing = versions.find((version) => version.text === text);
    if (existing) existing.labels.push(label);
    else versions.push({ labels: [label], text });
  }

  return <section aria-label="Text versions">
    {versions.map(({ labels, text }, index) => (
      <details className="original-transcript" key={index}>
        <summary>
          {labels.includes("Original transcription") && labels.includes("Pasted text")
            ? "Original and pasted text"
            : labels.join(" · ")}
          <ChevronDown size={14} />
        </summary>
        {labels.length > 1 && <p className="text-version-stages">{labels.join(" · ")}</p>}
        <p className="text-version-content">{text}</p>
      </details>
    ))}
  </section>;
}
