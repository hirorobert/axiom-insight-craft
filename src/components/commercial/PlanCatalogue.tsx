import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Button } from "@/components/ui/button";
import { NO_CHECKOUT_NOTICE, PRICING_CATALOGUE, formatCatalogueAmount, planIncludes, type CataloguePlan } from "@/lib/commercial/pricingCatalogue";
import { SERVICE_INTENTS, SERVICE_INTENT_IDS } from "@/lib/commercial/serviceIntent";

// One 12-month term for Solo, Practice and Firm (20261001120000_annual_commercial_term.sql): annual pricing only.
// Monthly pricing is not shown — the server cannot yet represent an instalment schedule against the annual commitment,
// and monthly offers are retired. Prices are proposed (the commercial structure is under final enforcement
// verification). The services every plan includes are stated ONCE, above the cards, derived from the plan × capability
// matrix; each card states only what differs. The raw feature matrix is not rendered: its plan-feature rows include
// outputs the interface does not reach (structured filing packs).
//
// The contact form exists only behind the service-enquiry gate: link to it only when its route exists, otherwise say
// plainly how a plan is obtained. Never a link to a page that is not there.
const COMMON_SERVICES = SERVICE_INTENT_IDS
  .filter((id) => PRICING_CATALOGUE.every((plan) => planIncludes(plan.code, SERVICE_INTENTS[id].capability)))
  .map((id) => SERVICE_INTENTS[id].name);

export function PlanCatalogue({ contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute }: { contactAvailable?: boolean } = {}) {
  const [selected, setSelected] = useState<CataloguePlan | null>(null);
  return <div>
    <p className="text-center text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground" data-testid="proposed-pricing">Proposed pricing · 12-month term</p>
    <ul className="mb-7 mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1" aria-label="Every plan includes" data-testid="common-services">
      {COMMON_SERVICES.map((name) => <li key={name} className="flex items-center gap-1.5 text-xs text-foreground"><Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{name}</li>)}
    </ul>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
      {PRICING_CATALOGUE.map((plan) => <li key={plan.code} data-testid={`plan-${plan.code}`} className="flex min-w-0 flex-col border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">{plan.name}</h2><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{plan.tagline}</p>
        <p className="mt-5 text-3xl font-semibold" data-testid={`price-${plan.code}`}>{plan.salesMode === "contact_sales" ? "Custom" : plan.annualMinor === null ? "Price unavailable" : formatCatalogueAmount(plan.annualMinor)}{plan.salesMode !== "contact_sales" && plan.annualMinor !== null && <span className="text-sm font-normal text-muted-foreground"> / year</span>}</p>
        <p className="mt-3 text-xs text-foreground">{plan.entityCapacity === null ? "Entity capacity by agreement" : `${plan.entityCapacity} active ${plan.entityCapacity === 1 ? "entity" : "entities"}`} · {plan.includedSeats === null ? "Named users by agreement" : `${plan.includedSeats} named user included`}</p>
        {plan.additionalSeat && <p className="mt-1 text-xs text-muted-foreground" data-testid={`seat-price-${plan.code}`}>Additional named user: {formatCatalogueAmount(plan.additionalSeat.annualMinor)} / year</p>}
        <ul className="my-6 flex-1 space-y-2" aria-label={`${plan.name} adds`}>
          {planIncludes(plan.code, "MULTI_ENTITY_REPORTING") && <li className="flex gap-2 text-xs text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />Multi-entity reporting</li>}
        </ul>
        <Button type="button" variant={plan.code === "PRACTICE" ? "default" : "outline"} className="w-full" onClick={() => setSelected(plan)}>{plan.salesMode === "contact_sales" ? "Discuss Enterprise" : `Choose ${plan.name}`}</Button>
      </li>)}
    </ul>
    {selected && <div role="status" className="mt-8 border-t border-border py-6 text-center"><h2 className="text-lg font-semibold">{selected.name}{selected.salesMode === "contact_sales" ? "" : " · 12-month term"}</h2><p className="mt-2 text-sm text-muted-foreground">{NO_CHECKOUT_NOTICE}</p><div className="mt-4 flex flex-wrap justify-center gap-3"><Button variant="outline" onClick={() => setSelected(null)}>Return to plans</Button>{contactAvailable ? <Button asChild><Link to="/contact">{selected.salesMode === "contact_sales" ? "Discuss Enterprise" : "Billing support"}</Link></Button> : <p className="self-center text-sm text-muted-foreground" data-testid="plan-activation-route">{selected.salesMode === "contact_sales" ? "Enterprise terms are agreed directly with our team." : "Plans are activated by the CFO Close team."}</p>}</div></div>}
  </div>;
}
