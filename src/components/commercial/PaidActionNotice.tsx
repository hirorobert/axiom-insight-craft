import { Link } from "react-router-dom";
import { ArrowRight, Lock } from "lucide-react";
import type { LockedCopy } from "@/lib/commercial/paidActions";

/**
 * Explains a paid action that is not available on the workspace's plan: what is unavailable, which plan enables it,
 * what remains available and that history is kept. Neutral styling (never a success colour or check mark). Its one
 * action leads to the signed-in plans page, where a plan is chosen and paid for (default "Choose a plan").
 */
export function PaidActionNotice({ copy, compact = false, testId, cta = { label: "Choose a plan", href: "/plans" } }: {
  copy: LockedCopy; compact?: boolean; testId?: string;
  /** The notice's one action. */
  cta?: { label: string; href: string };
}) {
  return (
    <div
      role="note"
      data-testid={testId ?? "paid-action-notice"}
      className={`min-w-0 border border-border bg-muted/30 ${compact ? "px-3 py-2" : "px-4 py-3"}`}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{copy.title}</span>
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.unavailable}</p>
      {!compact && <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.remains} {copy.history}</p>}
      <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link to={cta.href} className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline" data-testid="paid-action-cta">
          {cta.label} <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </span>
    </div>
  );
}
