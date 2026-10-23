import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

/** Native appearance is retained so existing workbench layouts do not change. */
export const ActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }>(
  ({ busy = false, busyLabel, children, disabled, className = "", ...props }, ref) => <button {...props} ref={ref}
    disabled={disabled || busy} aria-busy={busy || undefined} className={`inline-flex items-center justify-center gap-2 disabled:opacity-50 ${busy ? "cursor-wait" : "disabled:cursor-not-allowed"} ${className}`}>
    {busy && <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
    {busy && busyLabel ? busyLabel : children}
  </button>,
);
ActionButton.displayName = "ActionButton";
