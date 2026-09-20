import { useState, useEffect } from "react";
import { ArrowRight, ArrowUpRight, CircleCheck, Download, Loader2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import { LegalNotice } from "@/components/shared/LegalNotice.component";
import { PageLayout } from "@/components/shared/PageLayout.component";
import { installedReleaseNotes, ReleaseNotes, releaseUrl } from "@/components/shared/ReleaseNotes.component";
import { useUpdater } from "@/hooks/useUpdater.hook";
import { useAppStore } from "@/store/app.store";

export function AboutPage() {
  const [appVersion, setAppVersion] = useState("");
  const updateStatus = useAppStore((s) => s.updateStatus);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateProgress = useAppStore((s) => s.updateProgress);
  const updateError = useAppStore((s) => s.updateError);
  const updateNotes = useAppStore((s) => s.updateNotes);
  const updateCheckedAt = useAppStore((s) => s.updateCheckedAt);
  const { checkForUpdate, downloadAndInstall } = useUpdater();
  const updateBusy = ["checking", "downloading", "waiting", "installing"].includes(updateStatus);
  const showAvailableNotes = Boolean(updateVersion && ["available", "downloading", "waiting", "installing"].includes(updateStatus));
  const notesVersion = showAvailableNotes ? updateVersion! : appVersion;

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  const openLink = (url: string) => {
    void open(url).catch(() => useAppStore.getState().addToast({
      type: "error", message: "Could not open the link. Please try again.",
    }));
  };

  return (
    <PageLayout className="about-page">
      <div className="about-main">
        <section className="about-summary" aria-label="About Linty">
          <header className="about-identity">
            <img className="about-app-icon" src="/brand/icon.svg" alt="" width={72} height={72} draggable={false} />
            <div>
              <h1>Linty</h1>
              <p>Version {appVersion || "…"}</p>
            </div>
          </header>
          <p className="about-slogan">
            A little less typing.<br />
            <span>A little more flow.</span>
          </p>

          <div className="about-update">
            <div className="about-update-status" role="status" aria-live="polite">
              {updateStatus === "idle" && updateCheckedAt !== null && (
                <p className="installed-update-status"><CircleCheck size={14} aria-hidden="true" />You’re up to date.</p>
              )}
              {updateStatus === "checking" && (
                <p><Loader2 size={14} className="animate-spin" aria-hidden="true" />Checking for updates…</p>
              )}
              {updateStatus === "available" && updateVersion && <p>v{updateVersion} is ready to install.</p>}
              {updateStatus === "downloading" && (
                <>
                  <p>Downloading update… <span>{updateProgress}%</span></p>
                  <progress className="update-progress" value={updateProgress} max={100} aria-label="Update download progress" />
                </>
              )}
              {(updateStatus === "waiting" || updateStatus === "installing") && (
                <p>{updateStatus === "waiting" ? "Downloaded. Waiting for dictation to finish…" : "Installing and restarting…"}</p>
              )}
              {updateStatus === "error" && updateError && <p className="about-update-error">{updateError}</p>}
            </div>
            <div className="about-update-actions">
              {updateStatus === "available" && updateVersion && (
                <button className="standard-button primary-button" onClick={downloadAndInstall}>
                  <Download size={13} aria-hidden="true" />Install
                </button>
              )}
              <button className="standard-button" onClick={() => checkForUpdate()} disabled={updateBusy}>
                Check for updates
              </button>
              {updateStatus === "error" && (
                <button className="text-link" onClick={() => checkForUpdate()}>Retry</button>
              )}
            </div>
          </div>
        </section>

        <section className="about-release-card" aria-labelledby="about-release-title">
          <div className="about-release-heading">
            <h2 id="about-release-title" aria-label={showAvailableNotes ? undefined : "What’s new in this version"}>
              {showAvailableNotes ? `What’s new in v${notesVersion}` : "What’s new"}
            </h2>
            <span>{showAvailableNotes ? "Available" : appVersion || "…"}</span>
          </div>
          <ReleaseNotes notes={showAvailableNotes ? updateNotes : installedReleaseNotes(appVersion)} limit={3} />
          <button className="text-link" onClick={() => openLink(releaseUrl(notesVersion))}>
            Read full release notes <ArrowRight size={14} aria-hidden="true" />
          </button>
        </section>
      </div>

      <nav className="about-links" aria-label="Linty links">
        <button className="text-link" onClick={() => openLink("https://linty.ai")}>
          Website <ArrowUpRight size={12} aria-hidden="true" />
        </button>
        <button className="text-link" onClick={() => openLink("https://github.com/shekhardtu/linty")}>
          GitHub <ArrowUpRight size={12} aria-hidden="true" />
        </button>
        <button className="text-link" onClick={() => openLink("https://github.com/shekhardtu/linty/blob/main/SUPPORT.md")}>
          Get help <ArrowUpRight size={12} aria-hidden="true" />
        </button>
        <LegalNotice compact />
      </nav>
    </PageLayout>
  );
}
