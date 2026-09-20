import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useAppStore } from "@/store/app.store";
import { cn } from "@/lib/utils";
import type { ToastType } from "@/store/slices/toast.slice";

const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 size={13} className="text-success" />,
  error: <AlertCircle size={13} className="text-error" />,
  warning: <AlertTriangle size={13} className="text-warning" />,
  info: <Info size={13} className="text-info" />,
};

const TOAST_BORDER: Record<ToastType, string> = {
  success: "border-success/15",
  error: "border-error/15",
  warning: "border-warning/15",
  info: "border-info/15",
};

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);
  const [displayed, setDisplayed] = useState(toasts);
  useLayoutEffect(() => {
    setDisplayed((previous) => [
      ...previous.map((toast) => toasts.find((item) => item.toastId === toast.toastId) ?? toast),
      ...toasts.filter((toast) => !previous.some((item) => item.toastId === toast.toastId)),
    ]);
    const timer = setTimeout(() => setDisplayed(toasts),
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (!displayed.length) return null;

  return (
    <div className="fixed right-4 bottom-12 z-50 flex flex-col pointer-events-none">
      {displayed.map((toast) => {
        const exiting = !toasts.some((item) => item.toastId === toast.toastId);
        return (
          <div
            key={toast.toastId}
            className={cn("toast-slot", exiting && "is-exiting")}
            inert={exiting}
            aria-hidden={exiting || undefined}
          >
            <div className="toast-clip">
              <div
                role={exiting ? undefined : toast.type === "error" ? "alert" : "status"}
                className={cn(
                  "animate-toast-in pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2",
                  "bg-bg-elevated shadow-sm my-[3px]",
                  "max-w-[340px]",
                  TOAST_BORDER[toast.type],
                )}
              >
                {TOAST_ICONS[toast.type]}
                <span className="flex-1 text-[12px] text-text-primary leading-snug">
                  {toast.message}
                </span>
                {toast.action && (
                  <button
                    onClick={toast.action.onClick}
                    className="shrink-0 text-[12px] font-medium text-accent hover:text-accent-soft transition-colors"
                  >
                    {toast.action.label}
                  </button>
                )}
                <button
                  aria-label="Dismiss notification"
                  data-tooltip="Dismiss notification"
                  onClick={() => removeToast(toast.toastId)}
                  className="shrink-0 text-text-muted hover:text-text-secondary transition-colors"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
