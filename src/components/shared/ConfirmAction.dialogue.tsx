import { useEffect, useId, useRef } from "react";

export function ConfirmActionDialogue({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      previous?.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        e.preventDefault();
        buttons[
          (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus();
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-description`}>{description}</p>
      <div className="dialog-actions">
        <button
          ref={cancel}
          className="standard-button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="standard-button destructive-button"
          disabled={busy}
          onClick={onConfirm}
        >
          <span className="button-label-stack">
            <span aria-hidden={busy}>{confirmLabel}</span>
            <span aria-hidden={!busy}>Saving…</span>
          </span>
        </button>
      </div>
    </dialog>
  );
}
