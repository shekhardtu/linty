import { useLayoutEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/app.store";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function resolveTheme(preference: string, systemIsDark: boolean): "dark" | "light" {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemIsDark ? "dark" : "light";
}

export function useTheme() {
  const theme = useAppStore((s) => s.theme);

  useLayoutEffect(() => {
    if (!window.location.pathname.includes("capsule")) {
      void emitTo("capsule", "theme-changed", theme).catch(() => {});
    }
    const mq = window.matchMedia(MEDIA_QUERY);
    let firstFrame = 0;
    let secondFrame = 0;
    const apply = () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      document.documentElement.classList.add("theme-changing");
      const resolved = resolveTheme(theme, mq.matches);
      document.documentElement.setAttribute("data-theme", resolved);
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => document.documentElement.classList.remove("theme-changing"));
      });
    };

    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      document.documentElement.classList.remove("theme-changing");
    };
  }, [theme]);
}
