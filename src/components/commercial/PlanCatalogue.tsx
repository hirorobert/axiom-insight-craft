import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Button } from "@/components/ui/button";
import { NO_CHECKOUT_NOTICE, PRICING_CATALOGUE, formatCatalogueAmount, planIncludes, type CataloguePlan } from "@/lib/commercial/pricingCatalogue";
import { SERVICE_INTENTS, SERVICE_INTENT_IDS } from "@/lib/commercial/serviceIntent";

// One card per catalogue plan, stating only what differs: capacity and price. The financial close is mostly an annual
// event per entity, so the annual term is the headline and monthly billing is the alternative. Prices are proposed (the
// commercial structure is under final enforcement verification), and each card lists the four services the plan
// includes — derived from the plan × capability matrix — instead of the raw feature matrix, whose plan-feature rows
// include outputs the interface does not reach (structured filing packs).
//
// The contact form exists only behind the service-enquiry gate: link to it only when its route exists, otherwise say
// plainly how a plan is obtained. Never a link to a page that is not there.
const servicesIn = (plan: CataloguePlan) =>
  SERVICE_INTENT_IDS.filter((id) => planIncludes(plan.code, SERVICE_INTENTS[id].capability)).map((id) => SERVICE_INTENTS[id].name);

export function PlanCatalogue({ contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute }: { contactAvailable?: boolean } = {}) {
  const [selected, setSelected] = useState<CataloguePlan | null>(null);
  return <div>
    <p className="mb-6 text-center text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground" data-testid="proposed-pricing">Proposed pricing · annual term</p>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
      {PRICING_CATALOGUE.map((plan) => <li key={plan.code} data-testid={`plan-${plan.code}`} className="flex min-w-0 flex-col border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">{plan.name}</h2><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{plan.tagline}</p>
        <p className="mt-5 text-3xl font-semibold" data-testid={`price-${plan.code}`}>{plan.salesMode === "contact_sales" ? "Custom" : plan.annualMinor === null ? "Price unavailable" : formatCatalogueAmount(plan.annualMinor)}{plan.salesMode !== "contact_sales" && plan.annualMinor !== null && <span className="text-sm font-normal text-muted-foreground"> / year</span>}</p>
        {plan.salesMode !== "contact_sales" && plan.monthlyMinor !== null && <p className="mt-1 text-xs text-muted-foreground" data-testid={`monthly-${plan.code}`}>or {formatCatalogueAmount(plan.monthlyMinor)} / month, billed monthly</p>}
        <p className="mt-3 text-xs text-foreground">{plan.entityCapacity === null ? "Entity capacity by agreement" : `${plan.entityCapacity} active ${plan.entityCapacity === 1 ? "entity" : "entities"}`} · {plan.includedSeats === null ? "Named users by agreement" : `${plan.includedSeats} named user included`}</p>
        {plan.additionalSeat && <p className="mt-1 text-xs text-muted-foreground" data-testid={`seat-price-${plan.code}`}>Additional named user: {formatCatalogueAmount(plan.additionalSeat.annualMinor)} / year</p>}
        <ul className="my-6 flex-1 space-y-2" aria-label={`${plan.name} includes`}>
          {servicesIn(plan).map((name) => <li key={name} className="flex gap-2 text-xs text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />{name}</li>)}
          {planIncludes(plan.code, "MULTI_ENTITY_REPORTING") && <li className="flex gap-2 text-xs text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />Multi-entity reporting</li>}
        </ul>
        <Button type="button" variant={plan.code === "PRACTICE" ? "default" : "outline"} className="w-full" onClick={() => setSelected(plan)}>{plan.salesMode === "contact_sales" ? "Discuss Enterprise" : `Choose ${plan.name}`}</Button>
      </li>)}
    </ul>
    {selected && <div role="status" className="mt-8 border-t border-border py-6 text-center"><h2 className="text-lg font-semibold">{selected.name}{selected.salesMode === "contact_sales" ? "" : " · annual term"}</h2><p className="mt-2 text-sm text-muted-foreground">{NO_CHECKOUT_NOTICE}</p><div className="mt-4 flex flex-wrap justify-center gap-3"><Button variant="outline" onClick={() => setSelected(null)}>Return to plans</Button>{contactAvailable ? <Button asChild><Link to="/contact">{selected.salesMode === "contact_sales" ? "Discuss Enterprise" : "Billing support"}</Link></Button> : <p className="self-center text-sm text-muted-foreground" data-testid="plan-activation-route">{selected.salesMode === "contact_sales" ? "Enterprise terms are agreed directly with our team." : "Plans are activated by the CFO Close team."}</p>}</div></div>}
  </div>;
}
