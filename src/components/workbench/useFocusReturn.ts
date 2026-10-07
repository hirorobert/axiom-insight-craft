import { useEffect, useRef } from "react";

/**
 * While `open`, remembers the element that had focus when it opened and returns focus to it when it closes (or, if that
 * element was re-rendered away, to the element matching `fallbackSelector`).
 */
export function useFocusReturn(open: boolean, fallbackSelector?: string) {
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnTo.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const el = returnTo.current;
      if (el && el.isConnected) el.focus();
      else if (fallbackSelector) (document.querySelector(fallbackSelector) as HTMLElement | null)?.focus();
    };
  }, [open, fallbackSelector]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `container`. */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault(): void }, container: HTMLElement | null) {
  if (e.key !== "Tab" || !container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
