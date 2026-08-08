/**
 * Surface — the single presentation vocabulary for workspace screens.
 *
 * PRESENTATION ONLY. No data fetching, no routing decisions, no lock logic.
 * These primitives decide HOW something looks, never WHETHER it is shown.
 *
 * One card. One row. One status mark. One section label. One lock note.
 */

import * as React from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export type Tone = "muted" | "active" | "done" | "warn" | "bad" | "off";

export const TONE_DOT: Record<Tone, string> = {
  muted: "bg-muted-foreground/40",
  active: "bg-primary",
  done: "bg-success",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  off: "bg-muted-foreground/20",
};

export const TONE_TEXT: Record<Tone, string> = {
  muted: "text-muted-foreground",
  active: "text-primary",
  done: "text-success",
  warn: "text-amber-600",
  bad: "text-destructive",
  off: "text-muted-foreground/50",
};

/** ONE card. Same border, radius, padding and (absence of) shadow everywhere. */
export function SurfaceCard({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "rounded-none border border-border bg-card shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Card header band — same height and type scale on every card. */
export function SurfaceCardHeader({
  label,
  meta,
  action,
}: {
  label: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
      <div className="flex items-baseline gap-4 min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {label}
        </p>
        {meta && (
          <span className="text-[11px] tabular-nums text-muted-foreground/70 truncate">
            {meta}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

export function SurfaceCardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/** ONE status mark. Dot + word. Used at most once per subject on a page. */
export function StatusMark({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[12px] whitespace-nowrap",
        TONE_TEXT[tone],
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", TONE_DOT[tone])} />
      {label}
    </span>
  );
}

/**
 * ONE lock note. A padlock never appears without words next to it.
 * `reason` is passed in by the caller — this component does not decide it.
 */
export function LockNote({ reason }: { reason?: string | null }) {
  return (
    <span className="inline-flex items-start gap-2 text-[12px] text-muted-foreground">
      <Lock className="w-3.5 h-3.5 mt-[1px] shrink-0 text-muted-foreground/60" />
      <span className="leading-snug">
        Locked{reason ? ` — ${reason}` : " — an earlier step must pass first"}
      </span>
    </span>
  );
}

/**
 * ONE row. Every list item on every workspace screen uses this shape:
 *   [step no.] [icon] [title + note] [status] [affordance]
 */
export function LedgerRow({
  step,
  stepTone = "muted",
  icon,
  title,
  note,
  status,
  trailing,
  highlight,
  titleMuted,
  className,
}: {
  step?: string;
  stepTone?: Tone;
  icon?: React.ReactNode;
  title: React.ReactNode;
  note?: React.ReactNode;
  status?: React.ReactNode;
  trailing?: React.ReactNode;
  highlight?: boolean;
  titleMuted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[2.75rem_1.25rem_1fr_auto_1.25rem] items-center gap-4 px-5 py-3.5 border-b border-border transition-colors",
        highlight && "bg-primary/[0.03]",
        className,
      )}
    >
      <span
        className={cn(
          "text-[11px] font-mono tabular-nums",
          TONE_TEXT[stepTone],
          highlight && "font-semibold",
        )}
      >
        {step ?? ""}
      </span>
      <span className="inline-flex items-center justify-center">{icon}</span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-[14px] font-medium leading-tight tracking-tight",
            titleMuted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </p>
        {note && (
          <div className="mt-1 text-[12px] text-muted-foreground/80 leading-snug">
            {note}
          </div>
        )}
      </div>
      <div className="justify-self-end">{status}</div>
      <span className="inline-flex items-center justify-center">{trailing}</span>
    </div>
  );
}