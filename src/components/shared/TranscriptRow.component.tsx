import { isTauri } from "@tauri-apps/api/core";
import { showTranscriptMenu } from "@/lib/transcript-menu.util";
import { copyTranscript } from "@/lib/transcript-clipboard.util";
import { Archive, Cpu, Volume2 } from "lucide-react";
import { AppIcon } from "@/components/shared/AppIcon.component";
import { useAppIcon } from "@/hooks/useAppIcons.hook";
import { formatDuration } from "@/lib/usage.util";
import { cn } from "@/lib/utils";
import type { TranscriptRecord } from "@/types/transcript.types";

interface TranscriptRowProps {
  transcript: TranscriptRecord;
  selected?: boolean;
  onClick?: () => void;
  copyOnClick?: boolean;
  onDelete?: (id: string) => Promise<void>;
  actions?: React.ReactNode;
  className?: string;
  presentation?: "default" | "history";
}

export function TranscriptRow({
  transcript: t,
  selected,
  onClick,
  copyOnClick = false,
  onDelete,
  actions,
  className,
  presentation = "default",
}: TranscriptRowProps) {
  const appIcon = useAppIcon(t.application?.bundleId);
  const activate = copyOnClick
    ? () => {
        void copyTranscript(t);
      }
    : onClick;
  const time = (
    <time dateTime={new Date(t.timestamp).toISOString()}>
      {new Date(t.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
  const history = presentation === "history";
  const application = (
    <span className="transcript-app">
      <AppIcon
        size="sm"
        name={t.application?.name ?? "Application not recorded"}
        icon={appIcon}
        showNameOnHover={history}
      />
      {!history && (t.application?.name ?? "Dictation")}
    </span>
  );
  const content = (
    <>
      {history && (
        <span className="transcript-context">
          {application}
          {time}
        </span>
      )}
      <p className="transcript-preview">{t.finalText}</p>
      <span className="transcript-metadata">
        {!history && (
          <>
            {time}
            {t.application && (
              <>
                <span aria-hidden="true">·</span>
                {application}
              </>
            )}
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>{t.wordCount} words</span>
        {history && (
          <span className="transcript-audio">
            · {formatDuration(t.durationSeconds)}
          </span>
        )}
        {history && <span aria-hidden="true">·</span>}
        <span className="transcript-engine" title={t.modelName}>
          {!history &&
            (t.engine !== "local" ? <Archive size={11} /> : <Cpu size={11} />)}
          {t.engine !== "local" ? "Previous version" : history ? "On-device" : "Local"}
        </span>
        {history && t.audio && <span className="transcript-saved-audio" aria-label="Saved audio" title="Saved audio"><Volume2 size={12} aria-hidden="true" /></span>}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "transcript-row group",
        history && "transcript-row-history",
        onClick && "is-selectable",
        copyOnClick && "is-copyable",
        selected && "is-selected",
        className,
      )}
      onContextMenu={(e) => {
        if (!isTauri() || !onDelete) return;
        e.preventDefault();
        onClick?.();
        void showTranscriptMenu(t, onDelete);
      }}
      onKeyDown={(e) => {
        if (
          isTauri() &&
          onDelete &&
          (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        ) {
          e.preventDefault();
          onClick?.();
          void showTranscriptMenu(t, onDelete);
        }
      }}
    >
      {activate ? (
        <button
          type="button"
          data-transcript-id={t.transcriptId}
          aria-pressed={copyOnClick ? undefined : !!selected}
          aria-label={
            copyOnClick ? `Copy transcription: ${t.finalText}` : undefined
          }
          title={copyOnClick ? "Copy transcription" : undefined}
          onClick={(e) => {
            e.currentTarget.focus();
            activate();
          }}
          className="transcript-select"
        >
          {content}
        </button>
      ) : (
        <div className="transcript-select select-text">{content}</div>
      )}
      {actions && <div className="transcript-actions">{actions}</div>}
    </div>
  );
}
