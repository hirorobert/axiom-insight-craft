import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check } from "lucide-react";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Button } from "@/components/ui/button";
import { PRICING_CATALOGUE, planIncludes, type CataloguePlan, type PlanCode } from "@/lib/commercial/pricingCatalogue";
import { PAYMENT_UNAVAILABLE_NOTE, type CommercialSource } from "@/lib/commercial/offerings";
import { planPurchaseView, teamMembersLine, type PublicPrices } from "@/lib/commercial/planOffers";
import { CUSTOMER_SERVICE_INTENT_IDS, SERVICE_INTENTS } from "@/lib/commercial/serviceIntent";
import { WITHHELD_SERVICE_SURFACES_VISIBLE } from "@/lib/workspace/moduleAvailability";
import { PLAN_GROUPS, type PlanGroup } from "@/lib/commercial/purchaseJourney";

// One 12-month term for Solo, Practice and Firm (20261001120000_annual_commercial_term.sql): annual pricing only, no
// automatic renewal. Two groups, two cards each (owner decision 2026-10-20): "Small practices" (Solo, Practice) and
// "Firms" (Firm, Enterprise). The term and the services every plan includes (derived from the plan × capability matrix)
// are stated once, above the cards; each card states its price, its capacity and what that plan adds — never a withheld
// module.
//
// Price and action per plan come from planPurchaseView() over the server's public prices (passed in by the page): an
// approved price with online payment open → that price and "Get <plan>"; otherwise the catalogue figure marked
// "Proposed" and Contact support; Enterprise: "Talk to us". Until the server's prices have been read (prices === null) a
// self-serve card shows a neutral placeholder and no action, so it never flashes a commercial state the server may not
// hold (S2-C10). "Get <plan>" always opens the CFOClose checkout page — never the provider directly — so the term, the
// merchant of record and the refund terms are on screen before anything leaves for the payment page (S2-C02). The
// checkout page and the plans page's banner handle an unfinished earlier checkout.
const COMMON_SERVICES = CUSTOMER_SERVICE_INTENT_IDS
  .filter((id) => PRICING_CATALOGUE.every((plan) => planIncludes(plan.code, SERVICE_INTENTS[id].capability)))
  .map((id) => SERVICE_INTENTS[id].name);

/** The plan the eye should rest on. */
const RECOMMENDED: readonly PlanCode[] = ["PRACTICE"];

/** "USD 990 per year by card" → the figure "USD 990" (prefixed "Proposed: " when it is not yet approved) and "per year". */
const priceParts = (line: string): { figure: string; perYear: boolean } => {
  const m = /^(Proposed: )?([A-Z]{3} [\d,.]+) per year(?: by [a-z ]+)?$/.exec(line);
  return m ? { figure: `${m[1] ?? ""}${m[2]}`, perYear: true } : { figure: line, perYear: false };
};

function PlanCard({ plan, prices, source, contactAvailable }: { plan: CataloguePlan; prices: PublicPrices | null; source: CommercialSource; contactAvailable: boolean }) {
  const view = planPurchaseView(plan, prices, source);
  // Not yet read: the price and the action depend on the server's answer (Enterprise never does).
  const pending = prices === null && view.mode !== "enterprise";
  const actionable = view.mode === "online" || contactAvailable;
  const recommended = RECOMMENDED.includes(plan.code);
  const { figure, perYear } = priceParts(view.priceLines[0] ?? "");
  const label = view.mode === "online" ? `Get ${plan.name}` : view.mode === "enterprise" ? "Talk to us" : view.actionLabel;
  const team = teamMembersLine(plan);
  const checklist = [
    plan.entityCapacity === null ? "Entity capacity by agreement" : `${plan.entityCapacity} active ${plan.entityCapacity === 1 ? "entity" : "entities"}`,
    team,
    ...(WITHHELD_SERVICE_SURFACES_VISIBLE && planIncludes(plan.code, "MULTI_ENTITY_REPORTING") ? ["Multi-entity reporting"] : []),
  ];
  return (
    <li data-testid={`plan-${plan.code}`} data-mode={view.mode} data-recommended={recommended ? "true" : undefined}
      className={`relative flex min-w-0 flex-col rounded-xl border bg-card p-6 sm:p-8 ${recommended ? "border-primary shadow-md ring-1 ring-primary/30" : "border-border"}`}>
      {recommended && <span className="absolute right-6 top-6 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary" data-testid={`plan-badge-${plan.code}`}>Most popular</span>}
      <h2 className="text-xl font-semibold tracking-tight">{plan.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
      {pending ? (
        <div className="mt-6" role="status" data-testid={`price-pending-${plan.code}`}>
          <span className="sr-only">Loading the price…</span>
          <div className="h-9 w-32 animate-pulse rounded bg-muted sm:h-10" aria-hidden="true" />
          <div className="mt-2 h-4 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />
        </div>
      ) : (
        <div className="mt-6" data-testid={`price-${plan.code}`}>
          <p className="text-3xl font-semibold tracking-tight sm:text-4xl">{figure}</p>
          {perYear && <p className="mt-1 text-sm text-muted-foreground">per year</p>}
          {view.priceLines.slice(1).map((line) => <p key={line} className="mt-1 text-sm text-foreground">{line}</p>)}
        </div>
      )}
      <div className="my-6 h-px bg-border" />
      <ul className="flex-1 space-y-2.5" aria-label={`${plan.name} adds`}>
        {checklist.map((item) => (
          <li key={item} className="flex gap-2.5 text-sm text-foreground" data-testid={item === team ? `team-members-${plan.code}` : undefined}>
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{item}
          </li>
        ))}
      </ul>
      <div className="mt-8">
        {pending
          ? <div className="h-11 w-full animate-pulse rounded-md bg-muted" aria-hidden="true" data-testid={`action-pending-${plan.code}`} />
          : actionable
          ? <Button asChild size="lg" variant={recommended ? "default" : "outline"} className="w-full">
              <Link to={view.href} data-testid={view.mode === "online" ? `choose-plan-${plan.code}` : `contact-support-${plan.code}`}>
                {label}
              </Link>
            </Button>
          : <p className="text-sm text-muted-foreground" data-testid="plan-activation-route">{plan.salesMode === "contact_sales" ? "Enterprise terms are agreed directly with our team." : "Online payment is temporarily unavailable. Please try again later."}</p>}
        {view.mode === "unavailable" && prices !== null && <p className="mt-2 text-[11px] leading-4 text-muted-foreground" data-testid={`payment-unavailable-${plan.code}`}>{PAYMENT_UNAVAILABLE_NOTE}</p>}
      </div>
    </li>
  );
}

export function PlanCatalogue({ contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute, source = "landing_plans", prices = null, initialGroup }:
  { contactAvailable?: boolean; source?: CommercialSource; prices?: PublicPrices | null; initialGroup?: PlanGroup } = {}) {
  const [params] = useSearchParams();
  const [group, setGroup] = useState<PlanGroup>(params.get("tab") === "firms" ? "firms" : initialGroup ?? "small");
  return (
    <div>
      <p className="text-center text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground" data-testid="plan-term">12-month term · no automatic renewal</p>
      <ul className="mb-7 mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1" aria-label="Every plan includes" data-testid="common-services">
        {COMMON_SERVICES.map((name) => <li key={name} className="flex items-center gap-1.5 text-xs text-foreground"><Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{name}</li>)}
      </ul>
      <div className="flex justify-center">
        <div role="tablist" aria-label="Plan groups" className="inline-flex rounded-full border border-border bg-muted/40 p-1" data-testid="plan-groups">
          {PLAN_GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" id={`plan-tab-${g.id}`} aria-selected={group === g.id} aria-controls={`plan-panel-${g.id}`}
              onClick={() => setGroup(g.id)} data-testid={`plan-tab-${g.id}`}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${group === g.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {g.label}
            </button>
          ))}
        </div>
      </div>
      {/* Both groups are in the page (one hidden): every plan stays reachable to search, print and assistive technology. */}
      {PLAN_GROUPS.map((g) => (
        <div key={g.id} id={`plan-panel-${g.id}`} role="tabpanel" aria-labelledby={`plan-tab-${g.id}`} hidden={group !== g.id}>
          <ul className="mx-auto mt-8 grid max-w-4xl gap-6 md:grid-cols-2" aria-label={`${g.label} plans`}>
            {PRICING_CATALOGUE.filter((plan) => g.plans.includes(plan.code)).map((plan) =>
              <PlanCard key={plan.code} plan={plan} prices={prices} source={source} contactAvailable={contactAvailable} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}
