import { BookPlus, Check, Pencil, ScanLine } from "lucide-react";
import { normalizeWord } from "@/lib/correction-diff.util";
import { isKnownToDictionary, learnablePairs } from "@/lib/dictionary.util";
import { cn } from "@/lib/utils";
import type { CorrectionPair, CorrectionRecord, DictionaryEntry } from "@/types/correction.types";

interface CorrectionPanelProps {
  corrections: CorrectionRecord[];
  entries: DictionaryEntry[];
  onAddToDictionary: (right: string, wrong: string) => void;
  compact?: boolean;
  onShowHistory?: () => void;
}

function groupPairs(pairs: CorrectionPair[]) {
  const groups = new Map<string, { pair: CorrectionPair; count: number }>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.kind, pair.from, pair.to]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { pair, count: 1 });
  }
  return [...groups.values()];
}

/** What the person changed after a dictation, with one-click dictionary adds (styles: .correction-panel). */
export function CorrectionPanel({ corrections, entries, onAddToDictionary, compact = false, onShowHistory }: CorrectionPanelProps) {
  if (!corrections.length) return null;
  const records = compact ? corrections.slice(0, 1) : corrections;
  const moreHistory = compact && (corrections.length > 1 || groupPairs(records[0].pairs).length > 3);
  return (
    <section className={cn("correction-panel", compact && "is-compact")} aria-label={compact ? "Latest correction" : "Your edits"}>
      {records.map((record) => {
        const learnable = learnablePairs(record.pairs);
        const groups = groupPairs(record.pairs);
        return (
          <div key={record.correctionId} className="correction-record">
            {(!compact || record.source === "observed" || record.rewrite) && <p className="correction-meta">
              {record.source === "edit" ? <Pencil size={11} /> : <ScanLine size={11} />}
              {record.source === "edit" ? "Edited in Linty" : `Corrected in ${record.application?.name ?? "another app"}`}
              {!compact && <>{" · "}
              {new Date(record.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </>}
              {record.rewrite && <span className="correction-rewrite">rewrite, not used for learning</span>}
            </p>}
            <ul className="correction-pairs">
              {(compact ? groups.slice(0, 3) : groups).map(({ pair, count }, i) => {
                const learn = pair.kind === "substitution"
                  ? learnable.find((l) => normalizeWord(pair.from) === normalizeWord(l.from) && normalizeWord(pair.to) === normalizeWord(l.to))
                  : undefined;
                const known = learn ? isKnownToDictionary(entries, learn.from, learn.to) : false;
                return (
                  <li key={i} className={cn("correction-pair", `is-${pair.kind}`)}>
                    {pair.kind !== "insertion" && <del>{pair.from}</del>}
                    {pair.kind === "substitution" && <span aria-hidden="true">→</span>}
                    {pair.kind !== "deletion" && <ins>{pair.to}</ins>}
                    {count > 1 && <span className="correction-count">· {count} {pair.kind === "substitution" ? "replacements" : pair.kind === "insertion" ? "insertions" : "deletions"}</span>}
                    {learn && !record.rewrite && (
                      known ? (
                        <span className="correction-known" title="Already in your dictionary">
                          <Check size={11} /> In dictionary
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="correction-add"
                          onClick={() => onAddToDictionary(learn.to, learn.from)}
                          aria-label={`Add ${learn.to} to dictionary, replacing ${learn.from}`}
                        >
                          <BookPlus size={11} /> Add to dictionary
                        </button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {moreHistory && onShowHistory && <button type="button" className="text-link correction-history-link" onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onShowHistory();
      }}>View edit history</button>}
    </section>
  );
}
