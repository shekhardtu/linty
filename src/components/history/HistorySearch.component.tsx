import { Search, X } from "lucide-react";

export function HistorySearch({
  query,
  onChange,
}: {
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <div
      className="search-field history-search"
      role="search"
      aria-label="Search saved transcriptions"
    >
      <Search size={17} aria-hidden="true" />
      <input
        id="history-search"
        type="search"
        aria-label="Search transcripts or apps"
        placeholder="Search words or application name"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {query ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          data-tooltip="Clear search"
          onClick={() => {
            onChange("");
            document.getElementById("history-search")?.focus();
          }}
        >
          <X size={14} />
        </button>
      ) : (
        <kbd>⌘ F</kbd>
      )}
    </div>
  );
}
