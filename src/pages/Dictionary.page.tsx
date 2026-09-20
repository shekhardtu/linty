import { useMemo } from "react";
import {
  BookOpen,
  BookPlus,
  Lightbulb,
  Settings as SettingsIcon,
  Trash2,
  X,
} from "lucide-react";
import { useDictionary } from "@/hooks/useDictionary.hook";
import { useSettings } from "@/hooks/useSettings.hook";
import { useToast } from "@/hooks/useToast.hook";
import { useAppStore } from "@/store/app.store";
import {
  PageHeader,
  PageLayout,
} from "@/components/shared/PageLayout.component";
import { timesHelped } from "@/lib/dictionary.util";
import { formatDayLabel } from "@/lib/usage.util";
import { cn } from "@/lib/utils";
import type { DictionaryEntry } from "@/types/correction.types";

const number = (value: number) => value.toLocaleString();

const ORIGIN_LABEL: Record<DictionaryEntry["origin"], string> = {
  manual: "Added by you",
  learned: "Learned from a correction",
  imported: "Imported",
};

/** The personal dictionary: words Linty must get right, and suggestions learned from corrections. */
export function DictionaryPage() {
  const {
    entries,
    readySuggestions,
    loaded,
    addEntry,
    setEntryEnabled,
    removeEntry,
    acceptSuggestion,
    dismissSuggestion,
  } = useDictionary();
  const { dictionaryEnabled, autoLearnWords } = useSettings();
  const parakeetStatus = useAppStore((s) => s.parakeetVocabularyStatus);
  const correctionCount = useAppStore((s) => s.historySnapshot.correctionCount);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const { success, error } = useToast();
  const draft = useAppStore((s) => s.dictionaryDraft);
  const setDraft = useAppStore((s) => s.setDictionaryDraft);
  const clearDraft = useAppStore((s) => s.clearDictionaryDraft);
  const { right, wrong } = draft;

  const sortedEntries = useMemo(
    () =>
      [...entries].sort(
        (a, b) => timesHelped(b) - timesHelped(a) || b.createdAt - a.createdAt,
      ),
    [entries],
  );

  const submitNewWord = async (event: React.FormEvent) => {
    event.preventDefault();
    const rightForm = right.trim();
    if (!rightForm) return;
    const wrongForms = wrong
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    try {
      await addEntry(rightForm, wrongForms, "manual");
      clearDraft(draft);
      success(`“${rightForm}” added to your dictionary`);
    } catch {
      error("Could not save the word. Please try again.");
    }
  };

  const run = (work: Promise<void>, done: string) =>
    work
      .then(() => success(done))
      .catch(() => error("Could not update the dictionary. Please try again."));

  return (
    <PageLayout className="dictionary-page">
      <PageHeader
        page="dictionary"
        actions={
          <button
            className="dictionary-status"
            onClick={() => setSettingsSection("privacy")}
            title="Change in Settings → Privacy & storage"
          >
            <SettingsIcon size={13} />
            {dictionaryEnabled ? "Applying to new dictations" : "Paused"}
            {" · "}
            {autoLearnWords
              ? "learning automatically"
              : "asking before learning"}
          </button>
        }
      />

      <div className="dictionary-layout">
        <section className="dictionary-entries">
          <div className="section-heading">
            <div>
              <h2>
                <BookOpen size={16} className="text-text-muted" /> Your
                dictionary
              </h2>
              <p>
                Applied to every dictation and sent to the speech engine as
                hints
              </p>
            </div>
            <span className="metric-pill">
              {number(entries.length)} word{entries.length === 1 ? "" : "s"}
            </span>
          </div>
          {sortedEntries.length ? (
            <div className="app-table-scroll">
              <table className="app-usage-table is-dense dictionary-table">
                <thead>
                  <tr>
                    <th>Word</th>
                    <th>Heard as</th>
                    <th title="The speech engine got the word right because your dictionary was handed to it">
                      Recognised
                    </th>
                    <th title="Linty replaced a misheard spelling with this word after transcription">
                      Corrected
                    </th>
                    <th>Origin</th>
                    <th>On</th>
                    <th>
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEntries.map((e) => (
                    <tr
                      key={e.entryId}
                      className={cn(!e.enabled && "is-disabled")}
                    >
                      <td>
                        <strong>{e.right}</strong>
                      </td>
                      <td className="dictionary-wrong">
                        {e.wrong.length ? (
                          e.wrong.join(", ")
                        ) : (
                          <span className="text-text-muted">hint only</span>
                        )}
                      </td>
                      <td>{number(e.timesRecognized ?? 0)}</td>
                      <td>{number(e.timesApplied)}</td>
                      <td className="text-text-muted">
                        {ORIGIN_LABEL[e.origin]}
                      </td>
                      <td>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={e.enabled}
                          aria-label={`${e.enabled ? "Disable" : "Enable"} ${e.right}`}
                          className={cn("mini-switch", e.enabled && "is-on")}
                          onClick={() =>
                            run(
                              setEntryEnabled(e.entryId, !e.enabled),
                              e.enabled
                                ? `“${e.right}” paused`
                                : `“${e.right}” enabled`,
                            )
                          }
                        >
                          <i />
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${e.right}`}
                          data-tooltip={`Remove ${e.right}`}
                          onClick={() =>
                            run(removeEntry(e.entryId), `“${e.right}” removed`)
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : loaded ? (
            <div className="app-empty">
              <h3>Your dictionary is empty</h3>
              <p>
                Add a word below, or accept a suggestion once Linty has seen you
                correct one.
              </p>
            </div>
          ) : null}
        </section>

        <section className="dictionary-add">
          <div className="section-heading">
            <div>
              <h2>
                <BookPlus size={16} className="text-text-muted" /> Add a word
              </h2>
              <p>The spelling you want, and the ways it has come out wrong</p>
            </div>
          </div>
          <form className="dictionary-form" onSubmit={submitNewWord}>
            <label>
              <span className="field-label">Correct spelling</span>
              <input
                id="dictionary-right"
                value={right}
                onChange={(e) => setDraft({ right: e.target.value })}
                placeholder="Tauri"
                spellCheck={false}
              />
            </label>
            <label>
              <span className="field-label">Heard as (comma-separated, optional)</span>
              <input
                id="dictionary-wrong"
                value={wrong}
                onChange={(e) => setDraft({ wrong: e.target.value })}
                placeholder="Tari, Tory"
                spellCheck={false}
              />
            </label>
            <button
              type="submit"
              className="standard-button primary-button"
              disabled={!right.trim()}
            >
              <BookPlus size={12} /> Add to dictionary
            </button>
          </form>
        </section>

        <section className="dictionary-suggestions">
          <div className="section-heading">
            <div>
              <h2>
                <Lightbulb size={16} className="text-text-muted" /> Suggested
              </h2>
              <p>Corrections you made that look like words worth remembering</p>
            </div>
          </div>
          {readySuggestions.length ? (
            <ul className="dictionary-list">
              {readySuggestions.map((s) => (
                <li key={s.suggestionId} className="dictionary-row">
                  <div className="dictionary-word">
                    <del>{s.wrong}</del>
                    <span aria-hidden="true">→</span>
                    <strong>{s.right}</strong>
                    <span className="dictionary-note">
                      seen {s.seenCount}×, last{" "}
                      {formatDayLabel(s.lastSeenAt).toLowerCase()}
                    </span>
                  </div>
                  <div className="dictionary-actions">
                    <button
                      className="standard-button primary-button"
                      onClick={() =>
                        run(
                          acceptSuggestion(s.suggestionId),
                          `“${s.right}” added to your dictionary`,
                        )
                      }
                    >
                      <BookPlus size={12} /> Add
                    </button>
                    <button
                      className="standard-button"
                      aria-label={`Dismiss suggestion ${s.right}`}
                      onClick={() =>
                        run(
                          dismissSuggestion(s.suggestionId),
                          "Suggestion dismissed",
                        )
                      }
                    >
                      <X size={12} /> Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : loaded ? (
            <div className="app-empty">
              <h3>Nothing to review</h3>
              <p>
                {correctionCount
                  ? "Suggestions appear for verified spelling fixes in other apps, or after History corrections are seen twice, or once for names."
                  : "Open a transcript in History, choose Edit, and fix a word. Or turn on “Learn from corrections in other apps” in Settings and fix words where you dictate."}
              </p>
            </div>
          ) : null}
        </section>
      </div>
      <p className="dashboard-footnote">
        Your dictionary stays on this Mac. Whole words are replaced before
        pasting, and the most-used entries are sent to the speech engine as
        spelling hints. Reset all data clears it.
        {parakeetStatus === "ready" && " Parakeet’s vocabulary model is ready."}
        {parakeetStatus === "preparing" &&
          " Preparing Parakeet’s vocabulary model (about 100 MB, once)…"}
        {parakeetStatus === "error" &&
          " Parakeet’s vocabulary model could not be prepared; words are still fixed after transcription."}
      </p>
    </PageLayout>
  );
}
