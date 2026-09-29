import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store/app.store";
import { useUpdater } from "@/hooks/useUpdater.hook";

export function VersionIndicator({ children }: { children?: React.ReactNode }) {
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
    <div className="status-version">
      {children ?? <button onClick={() => setCurrentView("about")} title="About Linty">
        Linty {version}
      </button>}
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

