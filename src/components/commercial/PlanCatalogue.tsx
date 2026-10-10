import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Button } from "@/components/ui/button";
import { PRICING_CATALOGUE, planIncludes } from "@/lib/commercial/pricingCatalogue";
import { MANUAL_ACTIVATION_NOTE, type CommercialSource } from "@/lib/commercial/offerings";
import { additionalUserLine, planPurchaseView, type PublicPrices } from "@/lib/commercial/planOffers";
import { CUSTOMER_SERVICE_INTENT_IDS, SERVICE_INTENTS } from "@/lib/commercial/serviceIntent";
import { WITHHELD_SERVICE_SURFACES_VISIBLE } from "@/lib/workspace/moduleAvailability";

// One 12-month term for Solo, Practice and Firm (20261001120000_annual_commercial_term.sql): annual pricing only, no
// automatic renewal. The services every plan includes are stated ONCE, above the cards, derived from the plan ×
// capability matrix; each card states only what differs.
//
// Price and action per plan come from planPurchaseView() over the server's public prices (passed in by the page): an
// approved price with online payment open → that price and "Choose <plan>" (the signed-in checkout); otherwise the
// catalogue figure marked "Proposed" and "Request activation" (the enquiry form preselected with the plan) — shown only
// when the enquiry route exists, else a plain statement of how a plan is obtained. Enterprise: "Discuss Enterprise".
const COMMON_SERVICES = CUSTOMER_SERVICE_INTENT_IDS
  .filter((id) => PRICING_CATALOGUE.every((plan) => planIncludes(plan.code, SERVICE_INTENTS[id].capability)))
  .map((id) => SERVICE_INTENTS[id].name);

export function PlanCatalogue({ contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute, source = "landing_plans", prices = null }: { contactAvailable?: boolean; source?: CommercialSource; prices?: PublicPrices | null } = {}) {
  return <div>
    <p className="text-center text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground" data-testid="plan-term">12-month term · no automatic renewal</p>
    <ul className="mb-7 mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1" aria-label="Every plan includes" data-testid="common-services">
      {COMMON_SERVICES.map((name) => <li key={name} className="flex items-center gap-1.5 text-xs text-foreground"><Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{name}</li>)}
    </ul>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
      {PRICING_CATALOGUE.map((plan) => {
        const view = planPurchaseView(plan, prices, source);
        const extraUsers = additionalUserLine(plan);
        const actionable = view.mode === "online" || contactAvailable;
        return <li key={plan.code} data-testid={`plan-${plan.code}`} data-mode={view.mode} className="flex min-w-0 flex-col border border-border bg-card p-5">
          <h2 className="text-lg font-semibold">{plan.name}</h2><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{plan.tagline}</p>
          <div className="mt-5" data-testid={`price-${plan.code}`}>
            {view.priceLines.map((line, i) => <p key={line} className={i === 0 ? "text-lg font-semibold leading-6" : "mt-1 text-sm text-foreground"}>{line}</p>)}
          </div>
          <p className="mt-3 text-xs text-foreground">{plan.entityCapacity === null ? "Entity capacity by agreement" : `${plan.entityCapacity} active ${plan.entityCapacity === 1 ? "entity" : "entities"}`} · {plan.includedSeats === null ? "Named users by agreement" : `${plan.includedSeats} named user included`}</p>
          {extraUsers && <p className="mt-1 text-xs text-muted-foreground" data-testid={`seat-price-${plan.code}`}>{extraUsers}</p>}
          <ul className="my-6 flex-1 space-y-2" aria-label={`${plan.name} adds`}>
            {WITHHELD_SERVICE_SURFACES_VISIBLE && planIncludes(plan.code, "MULTI_ENTITY_REPORTING") && <li className="flex gap-2 text-xs text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />Multi-entity reporting</li>}
          </ul>
          {actionable
            ? <Button asChild variant={plan.code === "PRACTICE" ? "default" : "outline"} className="w-full"><Link to={view.href} data-testid={view.mode === "online" ? `choose-plan-${plan.code}` : `request-activation-${plan.code}`}>{view.actionLabel}</Link></Button>
            : <p className="text-sm text-muted-foreground" data-testid="plan-activation-route">{plan.salesMode === "contact_sales" ? "Enterprise terms are agreed directly with our team." : "Plans are activated by the CFOClose team."}</p>}
          {view.mode !== "online" && <p className="mt-2 text-[11px] leading-4 text-muted-foreground" data-testid={`activation-note-${plan.code}`}>{MANUAL_ACTIVATION_NOTE}</p>}
        </li>;
      })}
    </ul>
  </div>;
}
