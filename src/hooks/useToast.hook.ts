import { useAppStore } from "@/store/app.store";
import type { ToastType } from "@/store/slices/toast.slice";

export function useToast() {
  const { toasts, addToast, removeToast } = useAppStore();

  const toast = (type: ToastType, message: string, action?: { label: string; onClick: () => void }) => {
    addToast({ type, message, action });
  };

  return {
    toasts,
    toast,
    removeToast,
    success: (msg: string) => toast("success", msg),
    error: (msg: string) => toast("error", msg),
    warning: (msg: string) => toast("warning", msg),
    info: (msg: string) => toast("info", msg),
  };
}
