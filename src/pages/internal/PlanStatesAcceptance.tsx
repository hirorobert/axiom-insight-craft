/** Development-only, synthetic plan-state gallery. No account reads, writes or persisted selection. */
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
import { EntityCapacityNotice } from "@/components/commercial/EntityCapacityNotice";
import EngagementHub from "@/pages/workspace/EngagementHub";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";

const billing: BillingSummary = {
  hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null,
  effectiveEnd: null, billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null,
  nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null,
  entitlements: [],
};
const workspace: ActiveEngagementEntry = {
  engagementId: "synthetic-engagement", companyId: "synthetic-company", companyName: "Meridian Holdings",
  periodYear: 2025, engagementType: "financial_statements", framework: "IFRS for SMEs",
  capabilities: ["FINANCIAL_STATEMENTS"], openedAt: "2025-01-01T00:00:00Z",
  workspaceState: deriveWorkspaceState("synthetic-company", "Meridian Holdings", 2025, null),
};

export default function PlanStatesAcceptance() {
  const [params] = useSearchParams();
  if (!import.meta.env.DEV) return null;
  const state = params.get("state") ?? "new";
  const isArchive = state === "archive";
  const isCapacity = state === "capacity";
  return <div className="min-h-screen bg-background text-foreground">
    <header className="flex h-14 items-center border-b border-border px-6"><CFOCloseWordmark className="text-lg" /></header>
    <div className="mx-auto max-w-4xl px-5 py-10">
      <p role="status" className="mb-7 border-l-2 border-border bg-muted px-4 py-3 text-xs text-muted-foreground">Internal visual acceptance · synthetic account state · no customer data · not available on the published site</p>
      {state === "new" ? <><h1 className="text-3xl font-semibold">Choose your plan</h1><p className="my-5 text-sm text-muted-foreground">Online payment is not available yet; choosing a plan does not activate it.</p><Button asChild><Link to="/plans">View plans</Link></Button></> : <>
        <CurrentPlanPanel billing={isArchive ? { ...billing, licenceStatus: "EXPIRED" } : billing} capacity={{ determined: true, capacity: isArchive ? 0 : 1, used: 1, planCode: isArchive ? null : "SOLO" }} loading={false} error={false} archiveOnly={isArchive} />
        {isCapacity && <div className="my-8 border-t border-border pt-6"><h2 className="mb-3 text-lg font-semibold">Companies</h2><Button disabled variant="outline">Add Company</Button><div className="mt-3"><EntityCapacityNotice capacity={{ determined: true, capacity: 1, used: 1, planCode: "SOLO" }} loading={false} error={false} /></div></div>}
        <EngagementHub entries={[workspace]} companiesWithoutEngagement={[]} onResume={() => undefined} onStartService={() => undefined} />
      </>}
    </div>
  </div>;
}