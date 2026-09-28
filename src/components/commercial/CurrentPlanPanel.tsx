import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";
import { displayPlanName, displayLicenceStatus, formatLicenceDate } from "@/lib/commercial/billingDisplay";
import { planByCode } from "@/lib/commercial/pricingCatalogue";

export function CurrentPlanPanel({ billing, capacity, loading, error, onRetry, archiveOnly = false }: {
  billing: BillingSummary | null;
  capacity?: CapacityAnswer | null;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
  archiveOnly?: boolean;
}) {
  if (loading) return <div aria-label="Loading plan" className="space-y-3 py-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-48" /></div>;
  if (error || !billing) return <section aria-label="Current plan" className="space-y-3 border-t border-border py-5"><h2 className="text-lg font-semibold">We couldn’t load your plan</h2><p className="text-sm text-muted-foreground">Your account information is temporarily unavailable.</p>{onRetry && <Button variant="outline" onClick={onRetry}>Retry</Button>}</section>;
  const active = billing.licenceStatus === "ACTIVE" || billing.licenceStatus === "GRACE";
  const plan = planByCode(billing.planCode);
  const status = billing.licenceStatus;
  const title = active ? displayPlanName(billing.planCode) : status === "SUSPENDED" ? "Suspended" : archiveOnly ? "Archive-only" : status === "CANCELLED" ? "Cancelled" : status === "EXPIRED" ? "Expired" : status === "PENDING" ? "Pending" : status ? "Plan unavailable" : "No active plan";
  return <section aria-label="Current plan" className="border-t border-border py-5" data-testid="current-plan-panel">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><div><p className="text-xs font-medium uppercase text-muted-foreground">Current plan</p><h2 className="mt-1 text-xl font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{billing.licenceStatus ? displayLicenceStatus(billing.licenceStatus) : "No active plan"}</p></div><Button variant="outline" size="sm" asChild><Link to="/plans">View plans</Link></Button></div>
    <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {!active && billing.planCode && <div><dt className="text-muted-foreground">Previous plan</dt><dd className="font-medium">{displayPlanName(billing.planCode)}</dd></div>}
      {billing.billingInterval && <div><dt className="text-muted-foreground">Billing interval</dt><dd className="font-medium">{billing.billingInterval === "ANNUAL" ? "Annual" : "Monthly"}</dd></div>}
      {billing.effectiveStart && <div><dt className="text-muted-foreground">Effective from</dt><dd className="font-medium">{formatLicenceDate(billing.effectiveStart)}</dd></div>}
      {billing.effectiveEnd && <div><dt className="text-muted-foreground">Effective through</dt><dd className="font-medium">{formatLicenceDate(billing.effectiveEnd)}</dd></div>}
      {capacity && <div><dt className="text-muted-foreground">Entities</dt><dd className="font-medium">{capacity.used ?? "—"} in use · {capacity.determined && capacity.capacity !== null ? `${capacity.capacity} current capacity` : "Capacity unavailable"}</dd></div>}
      {active && plan?.includedSeats != null && <div><dt className="text-muted-foreground">Named users included</dt><dd className="font-medium">{plan.includedSeats}{plan.additionalSeat ? " · additional seats depend on your licence" : ""}</dd></div>}
    </dl>
    {!active && <p className="mt-5 text-sm text-muted-foreground">{status === "SUSPENDED" ? "Workspace access is suspended. Historical identity and audit records remain preserved." : "Existing workspaces and issued outputs remain readable for the account holder. New financial work requires an active plan."}</p>}
  </section>;
}
