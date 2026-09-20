import type { StateCreator } from "zustand";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  toastId: string;
  type: ToastType;
  message: string;
  action?: { label: string; onClick: () => void };
}

export interface ToastSlice {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "toastId">) => void;
  removeToast: (toastId: string) => void;
}

let toastCounter = 0;

export const createToastSlice: StateCreator<ToastSlice> = (set) => ({
  toasts: [],
  addToast: (toast) => {
    const toastId = `toast-${++toastCounter}`;
    set((state) => ({
      toasts: [...state.toasts.slice(-2), { ...toast, toastId }],
    }));
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.toastId !== toastId),
      }));
    }, toast.action ? 12000 : 5000);
  },
  removeToast: (toastId) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.toastId !== toastId),
    })),
});
