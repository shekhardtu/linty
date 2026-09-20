import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY = 400;
const LEAVE_DELAY = 150;
const SELECTOR = "button[data-tooltip]:not(:disabled)";

/** One tooltip for action controls, without wrappers that change their hit areas. */
export function ActionTooltip() {
  const id = useId();
  const tooltip = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLButtonElement | null>(null);
  const [text, setText] = useState("");
  const visible = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let candidate: HTMLButtonElement | null = null;
    const cancelTimer = () => clearTimeout(pending);
    const hide = () => {
      cancelTimer();
      candidate = null;
      visible.current = null;
      setTarget(null);
    };
    const getText = (button: HTMLButtonElement) =>
      button.dataset.tooltip || button.getAttribute("aria-label") || "";
    const usable = (button: HTMLButtonElement) =>
      button.isConnected && !button.disabled &&
      !button.closest('[inert],[aria-hidden="true"]') &&
      button.getClientRects().length > 0;
    const show = (button: HTMLButtonElement, delay: number) => {
      cancelTimer();
      if (candidate === button && visible.current === button) return;
      candidate = button;
      visible.current = null;
      setTarget(null);
      pending = setTimeout(() => {
        if (!usable(button) || !getText(button)) return;
        visible.current = button;
        setText(getText(button));
        setTarget(button);
      }, delay);
    };
    const buttonFor = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLButtonElement>(SELECTOR) : null;
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (event.target instanceof Node && tooltip.current?.contains(event.target)) {
        cancelTimer();
        return;
      }
      const button = buttonFor(event.target);
      if (button && !button.contains(event.relatedTarget as Node | null))
        show(button, HOVER_DELAY);
    };
    const out = (event: PointerEvent) => {
      const next = event.relatedTarget;
      if (candidate === document.activeElement && candidate?.matches(":focus-visible")) return;
      if (next instanceof Node &&
          (candidate?.contains(next) || tooltip.current?.contains(next))) return;
      if (buttonFor(event.target) === candidate ||
          (event.target instanceof Node && tooltip.current?.contains(event.target))) {
        cancelTimer();
        pending = setTimeout(hide, LEAVE_DELAY);
      }
    };
    const focus = (event: FocusEvent) => {
      const button = buttonFor(event.target);
      if (button?.matches(":focus-visible")) show(button, 0);
      else hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (visible.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        hide();
      } else if (event.key === "Enter" || event.key === " ") hide();
    };
    const observer = new MutationObserver(() => {
      if (!candidate) return;
      if (!usable(candidate)) hide();
      else if (visible.current === candidate) setText(getText(candidate));
    });
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["disabled", "aria-hidden", "inert", "aria-label", "data-tooltip"],
    });
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelTimer();
      observer.disconnect();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const tip = tooltip.current;
    if (!target || !tip) return;
    const descriptions = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    target.setAttribute("aria-describedby", [...descriptions, id].join(" "));
    tip.showPopover();
    const anchor = target.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(anchor.left + (anchor.width - box.width) / 2, window.innerWidth - box.width - 8));
    const below = anchor.bottom + 8;
    const y = below + box.height <= window.innerHeight - 8
      ? below : Math.max(8, anchor.top - box.height - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
    return () => {
      const remaining = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value && value !== id);
      if (remaining.length) target.setAttribute("aria-describedby", remaining.join(" "));
      else target.removeAttribute("aria-describedby");
      if (tip.isConnected && tip.matches(":popover-open")) tip.hidePopover();
    };
  }, [target, text, id]);

  return target ? createPortal(
    <div id={id} ref={tooltip} role="tooltip" popover="manual" className="floating-tooltip action-tooltip">
      {text}
    </div>,
    target.closest("dialog") ?? document.body,
  ) : null;
}
