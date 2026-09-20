import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { TRANSCRIPTION_LANGUAGES, languageLabel, nativeLanguageLabel } from "@/lib/languages.util";
import { cn } from "@/lib/utils";

const languages = TRANSCRIPTION_LANGUAGES.map((language) => ({ ...language, native: nativeLanguageLabel(language.code) }));

export function LanguagePicker({ value, onChange, disabled = false, label = "Transcription language", className, exclude = [], placeholder }: {
  value: string;
  onChange: (language: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  exclude?: readonly string[];
  placeholder?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320, maxHeight: 360 });
  const filtered = languages.filter(({ code, label, native }) => !exclude.includes(code) && `${label} ${native} ${code}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeCode = filtered.some((language) => language.code === active) ? active : filtered[0]?.code;
  const close = (restore = true) => {
    popup.current?.hidePopover();
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(value);
    popup.current?.showPopover();
    setOpen(true);
  };
  const choose = (language: string) => {
    close();
    if (language !== value) onChange(language);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 18;
      const above = rect.top - 18;
      const flip = below < 300 && above > below;
      const maxHeight = Math.max(0, Math.min(360, flip ? above : below));
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: flip ? rect.top - maxHeight - 6 : rect.bottom + 6, width, maxHeight });
    };
    place();
    search.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    const scroll = (event: Event) => { if (event.target instanceof Node && !popup.current?.contains(event.target)) place(); };
    document.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", scroll, true); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${id}-${activeCode}`);
    const list = document.getElementById(`${id}-list`);
    if (option && list) {
      const top = option.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
    }
  }, [activeCode, open, query, id]);

  useLayoutEffect(() => { if (disabled && open) close(false); }, [disabled, open]);

  return <>
    <button ref={trigger} type="button" role="combobox" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-popup`}
      disabled={disabled} className={cn("select-trigger language-picker-trigger", className)}
      onClick={() => open ? close() : show()}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); show(); }
      }}>
      <span>{value ? languageLabel(value) : placeholder ?? "Choose a language"}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    <div ref={popup} id={`${id}-popup`} popover="auto" role="dialog" aria-label="Choose a language" className="language-picker-popup" style={position}
      onToggle={(event) => { if (event.newState === "closed") setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Tab") close();
      }}>
      <div className="language-picker-search">
        <Search size={16} aria-hidden="true" />
        <input ref={search} role="combobox" aria-label="Search languages" aria-expanded={open} aria-controls={`${id}-list`}
          aria-autocomplete="list" aria-activedescendant={open && activeCode ? `${id}-${activeCode}` : undefined}
          placeholder="Search languages…" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const index = filtered.findIndex((language) => language.code === activeCode);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = filtered[Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
              if (next) setActive(next.code);
            }
            if (event.key === "Enter" && activeCode) { event.preventDefault(); choose(activeCode); }
          }} />
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={label} className="language-picker-options">
        {filtered.map((language) => <div key={language.code} id={`${id}-${language.code}`} role="option" aria-label={language.label}
          aria-selected={language.code === value} data-active={language.code === activeCode || undefined} className="language-picker-option"
          onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActive(language.code)} onClick={() => choose(language.code)}>
          <span><span>{language.label}</span><small lang={language.code === "auto" ? "en" : language.code}>{language.native}</small></span>
          {language.code === value && <Check size={15} aria-hidden="true" />}
        </div>)}
      </div>
      {!filtered.length && <p className="language-picker-empty" role="status">No languages found. Try another name.</p>}
    </div>
  </>;
}
