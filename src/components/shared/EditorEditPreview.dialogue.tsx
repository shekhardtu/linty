import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface Preview { id: string; original: string; replacement: string }

/** Native selection edits always stop here for review before touching another app. */
export function EditorEditPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const activePreview = useRef<string | null>(null);
  const operation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const off = listen<Preview>("editor-edit-preview", ({ payload }) => {
      activePreview.current = payload.id; operation.current += 1;
      setBusy(false); setError(""); setAccepted(false); setPreview(payload);
    });
    return () => { activePreview.current = null; operation.current += 1; void off.then(fn => fn()); };
  }, []);
  useEffect(() => {
    if (!preview || !dialog.current) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current.showModal();
    cancelButton.current?.focus();
    return () => { dialog.current?.close(); previous?.focus({ preventScroll: true }); };
  }, [preview]);
  const run = async (action: "cancel" | "accept" | "undo") => {
    if (!preview || busy) return;
    const id = preview.id;
    const revision = ++operation.current;
    const current = () => activePreview.current === id && operation.current === revision;
    setBusy(true); setError("");
    try {
      await invoke<void>(`${action}_editor_edit`, { id });
      if (!current()) return;
      if (action === "accept") setAccepted(true);
      else { activePreview.current = null; setPreview(null); }
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (current()) setBusy(false);
    }
  };
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby="editor-edit-title"
    onCancel={e => { e.preventDefault(); void run("cancel"); }}>
    <h2 id="editor-edit-title">{accepted ? "Edit applied" : "Review selected-text edit"}</h2>
    {accepted && <p role="status">The editor confirmed the replacement. Undo is available for two minutes while the text and selection stay unchanged.</p>}
    <p>Linty rechecks the original text and selection before applying. Pause typing in the original app while accepting or undoing. Previews expire after two minutes.</p>
    <label className="block mt-3">Original
      <textarea aria-label="Original selection" className="w-full mt-1" readOnly rows={4} value={preview?.original ?? ""} />
    </label>
    <label className="block mt-3">Proposed edit
      <textarea aria-label="Proposed edit" className="w-full mt-1" readOnly rows={4} value={preview?.replacement ?? ""} />
    </label>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button ref={cancelButton} className="standard-button" disabled={busy} onClick={() => { void run("cancel"); }}>{accepted ? "Done" : "Cancel"}</button>
      <button className="standard-button" disabled={busy || !preview || !!error} onClick={() => { void run(accepted ? "undo" : "accept"); }}>{busy ? "Working…" : accepted ? "Undo edit" : "Accept edit"}</button>
    </div>
  </dialog>;
}
