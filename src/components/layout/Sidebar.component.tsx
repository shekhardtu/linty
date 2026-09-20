import { useState, useRef, useEffect, useMemo } from "react";
import { Search, Loader2, ArrowDownToLine } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store/app.store";
import { useUpdater } from "@/hooks/useUpdater.hook";
import {
  NAVIGATION_ITEMS,
  SETTINGS_SECTIONS,
  type AppView,
  type SettingsSection,
} from "@/config/navigation.config";
import {
  BrandMark,
  SoundPattern,
} from "@/components/shared/BrandMark.component";
import { formatTriggerKeycap } from "@/lib/trigger.util";

interface SearchItem {
  label: string;
  category: string;
  keywords: string;
  view: AppView;
  section?: SettingsSection;
  icon: React.ReactNode;
}

const SEARCH_ITEMS: SearchItem[] = [
  ...NAVIGATION_ITEMS.map(({ id, label, keywords, icon: Icon }) => ({
    label,
    keywords,
    category: "Pages",
    view: id,
    icon: <Icon size={14} />,
  })),
  ...SETTINGS_SECTIONS.map(({ id, label, keywords, icon: Icon }) => ({
    label,
    keywords,
    category: "Settings",
    view: "settings" as const,
    section: id,
    icon: <Icon size={14} />,
  })),
];

function SidebarSearch() {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? SEARCH_ITEMS.filter((item) =>
          `${item.label} ${item.keywords} ${item.category}`
            .toLowerCase()
            .includes(q),
        )
      : [];
  }, [query]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => {
    if (isOpen)
      document
        .getElementById(`nav-result-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, isOpen]);
  const select = (item: SearchItem) => {
    if (item.section) useAppStore.getState().setSettingsSection(item.section);
    else useAppStore.getState().setCurrentView(item.view);
    setQuery("");
    setIsOpen(false);
    inputRef.current?.blur();
  };
  return (
    <div
      className="sidebar-search"
      ref={containerRef}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setIsOpen(false);
      }}
    >
      <div className="search-field">
        <Search size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          id="navigation-search"
          aria-label="Search Linty"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen && !!query.trim()}
          aria-controls={
            isOpen && query.trim() ? "navigation-results" : undefined
          }
          aria-activedescendant={
            isOpen && results.length ? `nav-result-${activeIndex}` : undefined
          }
          placeholder="Search Linty"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setIsOpen(false);
              setQuery("");
            }
            if (!results.length) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIsOpen(true);
              setActiveIndex(
                (i) =>
                  (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                  results.length,
              );
            }
            if (e.key === "Enter" && isOpen) {
              e.preventDefault();
              select(results[activeIndex]);
            }
          }}
        />
        {!query && <kbd>⌘K</kbd>}
      </div>
      {isOpen && query.trim() && (
        <div
          id="navigation-results"
          role="listbox"
          aria-label="Search results"
          className="navigation-results"
        >
          {results.length ? (
            results.map((item, i) => (
              <div
                key={item.label}
                id={`nav-result-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className="navigation-result"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(item)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {item.icon}
                <span>
                  {item.label}
                  <small>{item.category}</small>
                </span>
              </div>
            ))
          ) : (
            <p className="search-no-results">
              No matches. Try “language” or “microphone”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function VersionIndicator() {
  const [version, setVersion] = useState("");
  const { updateStatus, updateVersion, updateProgress, setCurrentView } =
    useAppStore();
  const { checkForUpdate, downloadAndInstall } = useUpdater();
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  return (
    <div className="sidebar-version">
      <button onClick={() => setCurrentView("about")} title="About Linty">
        Linty {version}
      </button>
      {updateStatus === "checking" && (
        <Loader2
          size={12}
          className="animate-spin"
          aria-label="Checking for updates"
        />
      )}
      {updateStatus === "downloading" && (
        <span role="status">{updateProgress}%</span>
      )}
      {updateStatus === "available" && (
        <button
          className="text-accent"
          onClick={downloadAndInstall}
          title={`Install version ${updateVersion}`}
        >
          <ArrowDownToLine size={12} /> Update
        </button>
      )}
      {updateStatus === "error" && (
        <button className="text-error" onClick={() => checkForUpdate()}>
          Retry update
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const {
    currentView,
    setCurrentView,
    settingsSection,
    setSettingsSection,
    triggerKey,
  } = useAppStore();
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector(
        currentView === "settings"
          ? ".settings-navigation [aria-current]"
          : '[aria-current="page"]',
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [currentView, settingsSection]);
  const nav = (view: AppView, label: string, icon: React.ReactNode) => (
    <button
      key={view}
      className="nav-button"
      aria-current={currentView === view ? "page" : undefined}
      onClick={() => setCurrentView(view)}
    >
      {icon}
      <span>{label}</span>
      {currentView === view && <BrandMark className="nav-signal" />}
    </button>
  );
  return (
    <aside id="app-sidebar" className="app-sidebar">
      <SoundPattern />
      <div className="sidebar-header">
        <span className="sidebar-header-artwork" aria-hidden="true" />
        <div data-tauri-drag-region className="sidebar-titlebar" />
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <span className="brand-name">Linty</span>
            <p className="eyebrow">A little less typing</p>
          </div>
        </div>
      </div>
      <SidebarSearch />
      <nav
        ref={navRef}
        aria-label="Main navigation"
        className="sidebar-navigation"
      >
        <p className="nav-group-label">Workspace</p>
        {NAVIGATION_ITEMS.filter((item) => item.group === "workspace").map(
          ({ id, label, icon: Icon }) => nav(id, label, <Icon size={16} />),
        )}
        <p className="nav-group-label utilities-label">Your setup</p>
        {NAVIGATION_ITEMS.filter(
          (item) => item.group === "setup" && item.id !== "about",
        ).map(({ id, label, icon: Icon }) =>
          nav(id, label, <Icon size={16} />),
        )}
        {currentView === "settings" && (
          <div className="settings-navigation" aria-label="Settings categories">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setSettingsSection(section.id)}
                aria-current={
                  settingsSection === section.id ? "true" : undefined
                }
              >
                {section.label}
              </button>
            ))}
          </div>
        )}
        {NAVIGATION_ITEMS.filter((item) => item.id === "about").map(
          ({ id, label, icon: Icon }) => nav(id, label, <Icon size={16} />),
        )}
      </nav>
      <div className="sidebar-breathing-space" aria-hidden="true" />
      <div className="sidebar-tip">
        <div className="sidebar-tip-shortcut">
          <span>Hold</span>
          <kbd>{formatTriggerKeycap(triggerKey)}</kbd>
        </div>
        <p>Release to paste.</p>
      </div>
      <VersionIndicator />
    </aside>
  );
}
