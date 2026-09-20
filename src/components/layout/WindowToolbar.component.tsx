import { PanelLeft } from "lucide-react";
import { useAppStore } from "@/store/app.store";
import { getPageDefinition } from "@/config/navigation.config";

export function WindowToolbar() {
  const {
    currentView,
    sidebarVisible,
    toggleSidebar,
  } = useAppStore();
  return (
    <header
      data-tauri-drag-region
      className={`window-toolbar ${sidebarVisible ? "" : "sidebar-hidden"}`}
    >
      <button
        className="icon-button"
        onClick={toggleSidebar}
        aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={sidebarVisible}
        aria-controls="app-sidebar"
        data-tooltip={`${sidebarVisible ? "Hide" : "Show"} sidebar (⌃⌘S)`}
      >
        <PanelLeft size={17} />
      </button>
      <span className="toolbar-title" data-tauri-drag-region>
        {getPageDefinition(currentView).label}
      </span>
      <div data-tauri-drag-region className="toolbar-space" />
    </header>
  );
}
