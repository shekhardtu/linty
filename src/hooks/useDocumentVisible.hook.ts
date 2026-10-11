import { useEffect, useState } from "react";

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Whether this window is on screen. Since 0.0.12 hidden windows keep running
 * (backgroundThrottling is disabled so update checks work in the menu bar), so
 * periodic UI work must pause itself while the window is hidden. WebKit reports
 * "hidden" for a window that was ordered out.
 */
export function useDocumentVisible() {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
