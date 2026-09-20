import { Select } from "@/components/shared/Select.component";
import { useState } from "react";
import { useAppStore } from "@/store/app.store";
import {
  clearHistory,
  exportHistory,
  previewRetention,
  setHistoryRetention,
} from "@/services/history.service";
import {
  SectionCard,
  SettingRow,
  ValueBadge,
} from "@/components/shared/SettingsLayout.component";
import { ConfirmActionDialogue } from "@/components/shared/ConfirmAction.dialogue";
import { HistoryStatus } from "@/components/shared/HistoryStatus.component";
import type { HistoryRetention } from "@/types/history.types";

export function HistoryStorage() {
  const { retentionDays, total } = useAppStore((s) => s.historySnapshot);
  const loaded = useAppStore((s) => s.historyLoaded);
  const historyError = useAppStore((s) => s.historyError);
  const notify = useAppStore((s) => s.addToast);
  const [pending, setPending] = useState<
    { days: HistoryRetention; count: number } | "clear" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const fail = (message: string, e: unknown) =>
    notify({ type: "error", message: `${message} ${String(e)}` });
  const chooseRetention = async (days: HistoryRetention) => {
    if (days === retentionDays) return;
    setBusy(true);
    try {
      if (days === 0) {
        await setHistoryRetention(days);
        notify({
          type: "success",
          message: "History will be kept until you delete it.",
        });
      } else setPending({ days, count: await previewRetention(days) });
    } catch (e) {
      fail("Could not change history retention.", e);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending === "clear") {
        await clearHistory();
        notify({ type: "success", message: "Transcription history cleared." });
      } else {
        await setHistoryRetention(pending.days);
        notify({
          type: "success",
          message: `History older than ${pending.days} days will be deleted automatically.`,
        });
      }
      setPending(null);
    } catch (e) {
      fail("Could not update saved history.", e);
    } finally {
      setBusy(false);
    }
  };
  const exportSaved = async () => {
    setBusy(true);
    try {
      const result = await exportHistory();
      if (result)
        notify({
          type: "success",
          message: `Exported ${result.count.toLocaleString()} transcriptions.`,
        });
    } catch (e) {
      fail("Could not export history.", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionCard>
        <HistoryStatus />
        <SettingRow
          label="History retention"
          description="Keep history until you delete it, or choose a retention period. Automatic cleanup runs at most once every 24 hours while Linty is running, and catches up on next launch. Manual deletion is immediate."
          right={
            <Select<HistoryRetention>
              label="History retention"
              value={retentionDays}
              disabled={!loaded || !!historyError || busy}
              onChange={(value) => void chooseRetention(value)}
              options={[
                { value: 0, label: "Until I delete it" },
                { value: 30, label: "30 days" },
                { value: 90, label: "90 days" },
                { value: 365, label: "1 year" },
              ]}
            />
          }
        />
        <SettingRow
          label="Saved history"
          description="Statistics include all retained transcriptions. Deleting or expiring history also removes its statistics."
          right={<ValueBadge>{total.toLocaleString()} saved</ValueBadge>}
        />
        <SettingRow
          label="Storage location"
          description="Your archive, corrections, and saved recordings are stored on this Mac. History export includes text and metadata; export audio separately from each dictation."
          right={<ValueBadge>On this Mac</ValueBadge>}
        />
        <div className="history-storage-actions">
          <button
            className="standard-button"
            disabled={!loaded || !!historyError || busy || !total}
            onClick={() => void exportSaved()}
          >
            Export history…
          </button>
          <button
            className="standard-button destructive-button"
            disabled={!loaded || !!historyError || busy || !total}
            onClick={() => setPending("clear")}
          >
            Clear history…
          </button>
        </div>
      </SectionCard>
      <ConfirmActionDialogue
        open={pending !== null}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirm()}
        title={
          pending === "clear"
            ? "Clear all transcription history?"
            : `Keep only ${pending?.days ?? 0} days of history?`
        }
        description={
          pending === "clear"
            ? "This permanently deletes all saved transcriptions, recordings, corrections, and history-based statistics. Your dictionary and settings are kept. Export anything you want to keep first."
            : `${pending?.count.toLocaleString() ?? 0} existing transcriptions will be permanently deleted now. After that, a daily cleanup deletes history older than ${pending?.days ?? 0} days, including recordings, corrections, and statistics. Expired history may remain until the next cleanup or launch.`
        }
        confirmLabel={pending === "clear" ? "Clear history" : "Apply retention"}
      />
    </>
  );
}
