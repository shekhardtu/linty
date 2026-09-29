import { refreshHistory } from "@/services/history.service";
import { useEffect, useCallback, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getStore } from "@tauri-apps/plugin-store";
import { useSettings } from "@/hooks/useSettings.hook";
import { useGlobalHotkey } from "@/hooks/useGlobalHotkey.hook";
import { useCorrectionObserver } from "@/hooks/useCorrectionObserver.hook";
import { useParakeetVocabulary } from "@/hooks/useParakeetVocabulary.hook";
import { useModelAutoLoad } from "@/hooks/useModelAutoLoad.hook";
import { useDictationPreparation } from "@/hooks/useDictationPreparation.hook";
import { useHistory } from "@/hooks/useHistory.hook";
import { useTheme } from "@/hooks/useTheme.hook";
import { useUpdater, useUpdaterAutoCheck } from "@/hooks/useUpdater.hook";
import { useUpdateAcknowledgment } from "@/hooks/useUpdateAcknowledgment.hook";
import { useTraySync } from "@/hooks/useTraySync.hook";
import { useAppStore } from "@/store/app.store";
import { checkMicrophonePermission } from "@/services/permissions.service";
import { Sidebar } from "@/components/layout/Sidebar.component";
import { WindowToolbar } from "@/components/layout/WindowToolbar.component";
import { StatusBar } from "@/components/layout/StatusBar.component";
import { RecordingFocus } from "@/components/RecordingFocus.component";
import { ConfirmResetDialogue } from "@/components/shared/ConfirmReset.dialogue";
import { UpdateRequiredDialogue } from "@/components/shared/UpdateRequired.dialogue";
import { UpdateAcknowledgmentDialogue } from "@/components/shared/UpdateAcknowledgment.dialogue";

import { ToastContainer } from "@/components/shared/ToastContainer.component";
import { HistoryPage } from "@/pages/History.page";
import { SettingsPage } from "@/pages/Settings.page";
import { DashboardPage } from "@/pages/Dashboard.page";
import { AppsPage } from "@/pages/Apps.page";
import { DictionaryPage } from "@/pages/Dictionary.page";
import { initializeDictionary } from "@/services/dictionary.service";
import { initializeCorrections } from "@/services/user-corrections.service";
import { SystemCheckPage } from "@/pages/SystemCheck.page";
import { ShortcutsPage } from "@/pages/Shortcuts.page";
import { AboutPage } from "@/pages/About.page";
import { OnboardingPage } from "@/pages/Onboarding.page";

export default function App() {
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const { saveTranscriptionLanguage, onboardingComplete, saveOnboardingComplete, settingsLoaded } = useSettings();

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [micPermission, setMicPermission] = useState<string | null>(null);
  const micPollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Restore microphone access if it is lost after setup.
  useEffect(() => {
    if (!onboardingComplete || !settingsLoaded) return;
    const poll = async () => {
      const status = await checkMicrophonePermission().catch(() => "not_determined");
      setMicPermission(status);
    };
    poll();
    micPollRef.current = setInterval(poll, 3000);
    return () => clearInterval(micPollRef.current);
  }, [onboardingComplete, settingsLoaded]);

  useEffect(() => {
    if (micPermission === "authorized" && micPollRef.current) clearInterval(micPollRef.current);
  }, [micPermission]);

  useTheme();
  useGlobalHotkey();
  useCorrectionObserver();
  useParakeetVocabulary();
  useModelAutoLoad();
  useDictationPreparation();
  useHistory();
  useEffect(() => {
    const refresh = () => { void refreshHistory().catch(() => {}); };
    const invalidated = listen("history-invalidated", () => {
      useAppStore.getState().invalidateHistoryCache();
      refresh();
    });
    const wake = listen("system-wake", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      void invalidated.then((off) => off());
      void wake.then((off) => off());
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useUpdaterAutoCheck();
  useUpdateAcknowledgment();
  useTraySync(saveTranscriptionLanguage);
  const { checkForUpdate } = useUpdater();

  const handleOnboardingComplete = useCallback(async () => {
    await saveOnboardingComplete(true);
  }, [saveOnboardingComplete]);

  // Menu: Check for Updates
  useEffect(() => {
    const unlisten = listen("menu-check-for-updates", () => {
      checkForUpdate();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [checkForUpdate]);

  // Menu: Reset All Data — show in-app confirmation dialog
  // (window.confirm is silently blocked by WKWebView — wry's WKUIDelegate
  //  does not implement runJavaScriptConfirmPanelWithMessage)
  useEffect(() => {
    const unlisten = listen("menu-reset-all-data", () => {
      setShowResetConfirm(true);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleResetConfirm = useCallback(async () => {
    setShowResetConfirm(false);
    try {
      // 1. Clear plugin-store in-memory caches — the Rust backend holds
      //    state that survives webview reload, so deleting files alone
      //    does nothing (autoSave re-writes them from memory).
      for (const name of ["linty-settings.json", "linty-history.json", "linty-corrections.json", "linty-dictionary.json"]) {
        const store = await getStore(name);
        if (store) { await store.clear(); await store.save(); }
      }

      // 2. Delete model files from disk + unload whisper from memory
      await invoke("reset_all_data");

      // 3. Reload webview — JS singletons reset, stores rehydrate empty
      window.location.reload();
    } catch (err) {
      console.error("Reset failed:", err);
      useAppStore.getState().addToast({ type: "error", message: "Could not reset all data. Please try again." });
    }
  }, []);

  // Commands yield to dialogs and controls that already handled the event.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!onboardingComplete || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setCurrentView("settings");
      } else if (e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        flushSync(() => setCurrentView("history"));
        document.getElementById("history-search")?.focus();
      } else if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!useAppStore.getState().sidebarVisible) useAppStore.getState().toggleSidebar();
        requestAnimationFrame(() => document.getElementById("navigation-search")?.focus());
      } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        useAppStore.getState().toggleSidebar();
      } else if (e.key === "Escape" && currentView !== "dashboard") {
        e.preventDefault();
        if (currentView === "settings" && (e.target as HTMLElement).matches("input, textarea")) {
          (e.target as HTMLElement).blur();
          return;
        }
        const state = useAppStore.getState();
        if (currentView === "history" && state.searchQuery) state.setSearchQuery("");
        else if (currentView === "history" && state.selectedTranscriptId) {
          const id = state.selectedTranscriptId;
          state.setSelectedTranscriptId(null);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-transcript-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
        }
        else setCurrentView("dashboard");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentView, setCurrentView, onboardingComplete]);

  // The dictionary must be in memory before the first dictation applies it.
  useEffect(() => {
    initializeDictionary().catch((error) => console.error("Failed to load dictionary:", error));
    initializeCorrections().catch((error) => console.error("Failed to load corrections:", error));
  }, []);

  useEffect(() => {
    const unlisten = listen("menu-settings", () => setCurrentView("settings"));
    return () => { unlisten.then((fn) => fn()); };
  }, [setCurrentView]);

  // Avoid flashing the first-run flow while saved preferences hydrate.
  if (!settingsLoaded) {
    return <div className="app-loading" role="status"><span className="loading-mark" />Opening Linty…</div>;
  }

  if (!onboardingComplete || (micPermission !== null && micPermission !== "authorized")) {
    return <>
      <OnboardingPage onComplete={handleOnboardingComplete} startAtMic={onboardingComplete} />
      <ToastContainer />
      <RecordingFocus />
      <UpdateRequiredDialogue />
    </>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {sidebarVisible && <Sidebar />}

      <div className="flex flex-1 flex-col min-w-0">
        <WindowToolbar />

        {/* Page content */}
        <main id="page-content" className="flex-1 min-h-0" aria-label={currentView}>
          {currentView === "history" && <HistoryPage />}
          {currentView === "settings" && <SettingsPage />}
          {currentView === "dashboard" && <DashboardPage />}
          {currentView === "apps" && <AppsPage />}
          {currentView === "dictionary" && <DictionaryPage />}
          {currentView === "system-check" && <SystemCheckPage />}
          {currentView === "shortcuts" && <ShortcutsPage />}
          {currentView === "about" && <AboutPage />}
        </main>

        <StatusBar />
      </div>

      <ToastContainer />
      <RecordingFocus />
      <ConfirmResetDialogue
        open={showResetConfirm}
        onConfirm={handleResetConfirm}
        onCancel={() => setShowResetConfirm(false)}
      />
      <UpdateRequiredDialogue />
      <UpdateAcknowledgmentDialogue paused={showResetConfirm} />
    </div>
  );
}
