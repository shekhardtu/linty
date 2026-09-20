import { useState, useEffect, useCallback } from "react";
import { LegalNotice } from "@/components/shared/LegalNotice.component";
import { Download, RefreshCw, ExternalLink } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "@/hooks/useUpdater.hook";
import { useAppStore } from "@/store/app.store";
import { SectionCard } from "@/components/shared/SettingsLayout.component";
import { cn } from "@/lib/utils";
import { PageLayout } from "@/components/shared/PageLayout.component";
import { BackgroundArtwork } from "@/components/shared/BackgroundArtwork.component";
import { installedReleaseNotes, ReleaseNotes, releaseUrl } from "@/components/shared/ReleaseNotes.component";

export function AboutPage() {
  const [appVersion, setAppVersion] = useState("");
  const updateStatus = useAppStore((s) => s.updateStatus);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateProgress = useAppStore((s) => s.updateProgress);
  const updateError = useAppStore((s) => s.updateError);
  const updateNotes = useAppStore((s) => s.updateNotes);
  const updateCheckedAt = useAppStore((s) => s.updateCheckedAt);
  const { checkForUpdate, downloadAndInstall } = useUpdater();

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  const handleCheckUpdate = useCallback(() => {
    checkForUpdate();
  }, [checkForUpdate]);

  return (
    <PageLayout reading className="about-page">
      <div className="flex flex-col gap-8">
        <header className="about-identity">
          <img className="about-app-icon" src="/brand/icon.svg" alt="" width={72} height={72} draggable={false} />
          <h1>Linty</h1>
          <p>
            A little less typing.
            <br />
            <span>A little more flow.</span>
          </p>
          <small>Version {appVersion || "…"}</small>
          {updateStatus === "idle" && updateCheckedAt !== null && (
            <p className="installed-update-status" role="status">You’re up to date.</p>
          )}
          <BackgroundArtwork motif="contour" />
        </header>

        {/* Update banner */}
        {updateStatus === "available" && updateVersion && (
          <SectionCard className="animate-fade-in">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-text-primary">
                  v{updateVersion} available
                </span>
                <span className="text-[11px] text-text-muted">
                  A new version is ready to install
                </span>
              </div>
              <button
                onClick={downloadAndInstall}
                className={cn(
                  "flex h-[30px] items-center gap-1.5 rounded-md px-3 text-[12px] font-medium",
                  "bg-accent text-white hover:bg-accent-soft active:scale-[0.97] transition-interaction duration-150",
                )}
              >
                <Download size={12} />
                Install
              </button>
            </div>
            <div className="available-release-notes">
              <h2>What’s new in v{updateVersion}</h2>
              <ReleaseNotes notes={updateNotes} />
            </div>
          </SectionCard>
        )}

        {updateStatus === "downloading" && (
          <SectionCard className="animate-fade-in">
            <div className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-text-primary">
                  Downloading update...
                </span>
                <span className="text-[11px] tabular-nums text-text-muted">
                  {updateProgress}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="progress-fill h-full rounded-full bg-accent"
                  style={{ transform: `scaleX(${updateProgress / 100})` }}
                />
              </div>
            </div>
          </SectionCard>
        )}

        {(updateStatus === "waiting" || updateStatus === "installing") && (
          <SectionCard>
            <p className="px-4 py-3 text-[13px] text-text-primary" role="status">
              {updateStatus === "waiting" ? "Downloaded. Waiting for dictation to finish…" : "Installing and restarting…"}
            </p>
          </SectionCard>
        )}

        {updateStatus === "error" && updateError && (
          <SectionCard className="animate-fade-in">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-[13px] text-error">{updateError}</span>
              <button
                onClick={handleCheckUpdate}
                className="text-[12px] text-accent hover:text-accent-soft transition-colors"
              >
                Retry
              </button>
            </div>
          </SectionCard>
        )}

        <SectionCard>
          <section className="about-release-notes" aria-labelledby="installed-release-title">
            <h2 id="installed-release-title">What’s new in this version</h2>
            <ReleaseNotes notes={installedReleaseNotes(appVersion)} />
            <button className="standard-button" onClick={() => {
              void open(releaseUrl(appVersion)).catch(() => useAppStore.getState().addToast({
                type: "error", message: "Could not open the release notes. Please try again.",
              }));
            }}>View release notes</button>
          </section>
        </SectionCard>

        {/* Action buttons */}
        <SectionCard>
          <div className="flex flex-col">
            <button
              onClick={handleCheckUpdate}
              disabled={
                updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "waiting" || updateStatus === "installing"
              }
              className={cn(
                "flex items-center justify-between px-4 py-[10px] hover:bg-bg-hover transition-colors border-b border-border-subtle",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <span className="text-[13px] text-text-primary">
                Check for updates
              </span>
              <RefreshCw
                size={13}
                className={cn(
                  "text-text-muted",
                  updateStatus === "checking" && "animate-spin",
                )}
              />
            </button>
            <button
              onClick={() => open("https://linty.ai")}
              className="flex items-center justify-between px-4 py-[10px] hover:bg-bg-hover transition-colors border-b border-border-subtle"
            >
              <span className="text-[13px] text-text-primary">Website</span>
              <ExternalLink size={13} className="text-text-muted" />
            </button>
            <button
              onClick={() => open("https://github.com/shekhardtu/linty")}
              className="flex items-center justify-between px-4 py-[10px] hover:bg-bg-hover transition-colors border-b border-border-subtle"
            >
              <span className="text-[13px] text-text-primary">GitHub</span>
              <ExternalLink size={13} className="text-text-muted" />
            </button>
            <button
              onClick={() =>
                open("https://github.com/shekhardtu/linty/blob/main/LICENSE")
              }
              className="flex items-center justify-between px-4 py-[10px] hover:bg-bg-hover transition-colors"
            >
              <span className="text-[13px] text-text-primary">License</span>
              <ExternalLink size={13} className="text-text-muted" />
            </button>
          </div>
        </SectionCard>

        <LegalNotice />
        <p className="text-[11px] text-text-muted text-center leading-relaxed">
          Made with care. Your voice, your data, your device.
        </p>
      </div>
    </PageLayout>
  );
}
