import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** One select-only combobox: keyboard focus stays on its trigger while the list uses the top layer. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const pointerNavigation = useRef(false);
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const close = (restoreFocus = false) => {
    list.current?.hidePopover();
    setOpen(false);
    typeahead.current.text = "";
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const show = (
    index = selected >= 0
      ? selected
      : options.findIndex((option) => !option.disabled),
  ) => {
    if (disabled) return;
    pointerNavigation.current = false;
    setActive(index);
    list.current?.showPopover();
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 210), window.innerWidth - 16);
      const desired = Math.min(296, options.length * 34 + 10);
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const flip = below < desired && above > below;
      const maxHeight = Math.max(0, Math.min(desired, flip ? above : below));
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flip ? rect.top - maxHeight - 6 : rect.bottom + 6,
        width,
        maxHeight,
      });
    };
    place();
    const onScroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !list.current?.contains(event.target)
      )
        place();
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, options.length]);

  useLayoutEffect(() => {
    const menu = list.current;
    if (!open || !position || !menu || pointerNavigation.current) return;
    const option = menu.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!option) return;
    // Scroll only the options, never the containing settings/page pane.
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [active, open, position]);

  useEffect(() => {
    if (disabled && open) {
      list.current?.hidePopover();
      setOpen(false);
    }
  }, [disabled, open]);

  return (
    <>
      <button
        type="button"
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        disabled={disabled}
        className={cn("select-trigger", className)}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          open ? close() : show();
        }}
        onBlur={() => {
          if (open) close();
        }}
        onKeyDown={(event) => {
          pointerNavigation.current = false;
          const { key } = event;
          if (key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
            return;
          }
          if (key === "Tab") {
            if (open) close();
            return;
          }
          if (key === "Enter" || key === " ") {
            event.preventDefault();
            open ? choose(active) : show();
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
            event.preventDefault();
            const enabled = options
              .map((option, index) => (option.disabled ? -1 : index))
              .filter((index) => index >= 0);
            const current = enabled.indexOf(active);
            const next =
              key === "Home"
                ? enabled[0]
                : key === "End"
                  ? enabled[enabled.length - 1]
                  : !open
                    ? selected >= 0
                      ? selected
                      : enabled[key === "ArrowDown" ? 0 : enabled.length - 1]
                    : enabled[
                        Math.max(
                          0,
                          Math.min(
                            enabled.length - 1,
                            current + (key === "ArrowDown" ? 1 : -1),
                          ),
                        )
                      ];
            if (!open) show(next);
            else if (next !== undefined) setActive(next);
            return;
          }
          if (
            key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const now = Date.now();
            const prior =
              now - typeahead.current.at < 700 ? typeahead.current.text : "";
            const text = prior + key.toLocaleLowerCase();
            typeahead.current = { text, at: now };
            const query = [...text].every((char) => char === text[0])
              ? text[0]
              : text;
            const start = query.length === 1 ? active + 1 : active;
            const index = options
              .map(
                (_, offset) => (Math.max(0, start) + offset) % options.length,
              )
              .find(
                (index) =>
                  !options[index].disabled &&
                  options[index].label.toLocaleLowerCase().startsWith(query),
              );
            if (index !== undefined) {
              if (!open) show(index);
              else setActive(index);
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? "Choose an option"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div
        id={id}
        ref={list}
        role="listbox"
        aria-label={label}
        popover="auto"
        className="select-list"
        style={{ ...position, visibility: position ? "visible" : "hidden" }}
        onToggle={(event) => {
          if (event.newState === "closed") setOpen(false);
        }}
        onPointerDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <div
            key={option.value}
            id={`${id}-${index}`}
            role="option"
            aria-label={option.label}
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            data-index={index}
            data-active={index === active || undefined}
            className="select-option"
            onPointerMove={() => {
              pointerNavigation.current = true;
              if (!option.disabled) setActive(index);
            }}
            onClick={(event) => {
              event.stopPropagation();
              choose(index);
            }}
          >
            <span>{option.label}</span>
            <Check size={14} aria-hidden="true" />
          </div>
        ))}
      </div>
    </>
  );
}
