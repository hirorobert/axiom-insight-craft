import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Button } from "@/components/ui/button";
import { NO_CHECKOUT_NOTICE, PRICING_CATALOGUE, MATRIX_CAPABILITIES, formatCatalogueAmount, matrixCapabilityName, planIncludes, type CataloguePlan } from "@/lib/commercial/pricingCatalogue";

type Interval = "monthly" | "annual";
// The contact form exists only behind the service-enquiry gate (OFF by default): link to it only when its route exists,
// otherwise say plainly how a plan is obtained. Never a link to a page that is not there.
export function PlanCatalogue({ contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute }: { contactAvailable?: boolean } = {}) {
  const [interval, setInterval] = useState<Interval>("annual");
  const [selected, setSelected] = useState<CataloguePlan | null>(null);
  return <div>
    <div className="mb-7 flex justify-center" role="group" aria-label="Billing interval">
      {(["monthly", "annual"] as const).map((value) => <Button key={value} type="button" variant={interval === value ? "default" : "outline"} aria-pressed={interval === value} onClick={() => { setInterval(value); setSelected(null); }} className="rounded-none">{value === "monthly" ? "Monthly" : "Annual"}</Button>)}
    </div>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
      {PRICING_CATALOGUE.map((plan) => <li key={plan.code} data-testid={`plan-${plan.code}`} className="flex min-w-0 flex-col border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">{plan.name}</h2><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{plan.tagline}</p>
        <p className="mt-5 text-3xl font-semibold" data-testid={`price-${plan.code}`}>{plan.salesMode === "contact_sales" ? "Custom" : (interval === "annual" ? plan.annualMinor : plan.monthlyMinor) === null ? "Price unavailable" : formatCatalogueAmount(interval === "annual" ? plan.annualMinor : plan.monthlyMinor)}{plan.salesMode !== "contact_sales" && (interval === "annual" ? plan.annualMinor : plan.monthlyMinor) !== null && <span className="text-sm font-normal text-muted-foreground"> / {interval === "annual" ? "year" : "month"}</span>}</p>
        <p className="mt-2 text-xs text-muted-foreground">{plan.entityCapacity === null ? "Entity capacity by agreement" : `${plan.entityCapacity} active ${plan.entityCapacity === 1 ? "entity" : "entities"}`} · {plan.includedSeats === null ? "Named users by agreement" : `${plan.includedSeats} named user included`}</p>
        {plan.additionalSeat && <p className="mt-2 text-xs text-muted-foreground" data-testid={`seat-price-${plan.code}`}>Additional named user: {formatCatalogueAmount(interval === "annual" ? plan.additionalSeat.annualMinor : plan.additionalSeat.monthlyMinor)} / {interval === "annual" ? "year" : "month"}</p>}
        <ul className="my-6 flex-1 space-y-2" aria-label={`${plan.name} includes`}>{MATRIX_CAPABILITIES.filter((cap) => planIncludes(plan.code, cap)).map((cap) => <li key={cap} className="flex gap-2 text-xs text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />{matrixCapabilityName(cap)}</li>)}</ul>
        <Button type="button" variant={plan.code === "PRACTICE" ? "default" : "outline"} className="w-full" onClick={() => setSelected(plan)}>{plan.salesMode === "contact_sales" ? "Talk to sales" : `Choose ${plan.name}`}</Button>
      </li>)}
    </ul>
    {selected && <div role="status" className="mt-8 border-t border-border py-6 text-center"><h2 className="text-lg font-semibold">{selected.name} · {interval === "annual" ? "Annual" : "Monthly"}</h2><p className="mt-2 text-sm text-muted-foreground">{NO_CHECKOUT_NOTICE}</p><div className="mt-4 flex flex-wrap justify-center gap-3"><Button variant="outline" onClick={() => setSelected(null)}>Return to plans</Button>{contactAvailable ? <Button asChild><Link to="/contact">{selected.salesMode === "contact_sales" ? "Talk to sales" : "Billing support"}</Link></Button> : <p className="self-center text-sm text-muted-foreground" data-testid="plan-activation-route">{selected.salesMode === "contact_sales" ? "Contact sales through your CFO Close account team." : "Plans are activated by the CFO Close team."}</p>}</div></div>}
  </div>;
}
