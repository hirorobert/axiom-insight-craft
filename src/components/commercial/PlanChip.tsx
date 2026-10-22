import { Link } from "react-router-dom";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { planChipView } from "@/lib/commercial/purchaseJourney";

const PILL = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 text-xs";

/**
 * The account's plan, stated once in the signed-in header: "No plan · Choose a plan", "<Plan> plan", or "Plan expired · Renew".
 * Read from the caller's own billing account (get_my_billing_summary); presentation only, never a gate. It never claims a
 * state it does not know (NULL is not computed): while loading, on a read error, for a person who holds no billing account
 * (a team member of another account) or for a pending/suspended licence it shows nothing. There is no free plan, so the
 * no-plan state never says "Free".
 */
export function PlanChip({ className = "" }: { className?: string }) {
  const { summary, loading, error } = useBillingSummary();
  const view = planChipView(summary, loading, error);
  if (view.kind === "none") return null;
  if (view.kind === "current") {
    return <span className={`${PILL} text-muted-foreground ${className}`} data-testid="plan-chip" data-state="current">{view.label}</span>;
  }
  return (
    <Link to={view.href} className={`${PILL} transition-colors hover:bg-muted ${className}`} data-testid="plan-chip" data-state={view.kind}>
      <span className="text-muted-foreground">{view.label}</span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="font-medium text-foreground">{view.action}</span>
    </Link>
  );
}
