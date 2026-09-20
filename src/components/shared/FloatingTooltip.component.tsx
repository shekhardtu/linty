import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Point {
  x: number;
  y: number;
}

/** One overlay outside chart stacking contexts, bounded by its visible surface. */
export function FloatingTooltip({
  id,
  anchor,
  boundary,
  children,
}: {
  id: string;
  anchor: Point;
  boundary: HTMLElement;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!tooltip) return;
    const inset = 8;
    const offset = 14;
    const surface = boundary.getBoundingClientRect();
    const viewport = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    // The chart may be partly hidden by a scrolling pane or sticky window chrome.
    for (
      let parent = boundary.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        viewport.left = Math.max(viewport.left, rect.left);
        viewport.right = Math.min(viewport.right, rect.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        viewport.top = Math.max(viewport.top, rect.top);
        viewport.bottom = Math.min(viewport.bottom, rect.bottom);
      }
    }
    const left = Math.max(viewport.left, surface.left) + inset;
    const right = Math.min(viewport.right, surface.right) - inset;
    let top = Math.max(viewport.top, surface.top) + inset;
    let bottom = Math.min(viewport.bottom, surface.bottom) - inset;
    tooltip.style.maxWidth = `${Math.max(0, right - left)}px`;
    const { width, height } = tooltip.getBoundingClientRect();
    if (bottom - top < height) {
      top = viewport.top + inset;
      bottom = viewport.bottom - inset;
    }
    const x =
      anchor.x + offset + width <= right
        ? anchor.x + offset
        : anchor.x - offset - width;
    const y =
      anchor.y - offset - height >= top
        ? anchor.y - offset - height
        : anchor.y + offset;
    setPosition({
      x: Math.max(left, Math.min(x, right - width)),
      y: Math.max(top, Math.min(y, bottom - height)),
    });
  }, [anchor.x, anchor.y, boundary, children]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="floating-tooltip"
      style={{
        transform: position ? `translate(${position.x}px, ${position.y}px)` : undefined,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
