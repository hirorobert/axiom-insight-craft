/**
 * CapacityPlans — the CAPACITY decision. Every figure comes from the reviewed catalogue (PRICING_CATALOGUE through
 * PROPOSED_PLANS); prices stay labelled "Proposed" (an explicit commercial decision is needed to change that).
 *
 * Every plan action is "Request activation" (Enterprise: "Discuss Enterprise"): the enquiry form preselected with that plan
 * (src/lib/commercial/offerings.ts). Subscriptions are sold by agreement and activated by our team; that is stated beside
 * every action. Nothing here activates a plan, and online payment is off. Without the enquiry surface, a plain statement.
 *
 * One structure for every width: an ARIA table that lays out as rows on wide screens and as stacked cards on phones.
 */

import { Link } from "react-router-dom";
import { LANDING_PLANS_COPY } from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";
import { activationHref, REQUEST_ACTIVATION_LABEL } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

const C = LANDING_PLANS_COPY.columns;
const CELL = "px-4 py-2 md:py-4 text-[13px] leading-5";
const MOBILE_LABEL = "md:hidden block text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground";

export function CapacityPlans() {
  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-20 border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:px-10 lg:py-20">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_PLANS_COPY.eyebrow}</p>
          <h2 id="plans-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">
            {LANDING_PLANS_COPY.heading}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{LANDING_PLANS_COPY.intro}</p>
        </div>

        <div role="table" aria-labelledby="plans-title" className="mt-10 border border-border" data-testid="capacity-table">
          <div role="rowgroup" className="sr-only md:not-sr-only">
            <div role="row" className="hidden grid-cols-12 border-b border-border bg-muted/30 md:grid">
              {[[C.plan, "col-span-2"], [C.bestFor, "col-span-3"], [C.entities, "col-span-1"], [C.users, "col-span-2"], [C.price, "col-span-2"], [C.action, "col-span-2"]].map(([label, span]) => (
                <span key={label} role="columnheader" className={`${span} px-4 py-3 text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground`}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div role="rowgroup" className="divide-y divide-border">
            {PROPOSED_PLANS.map((p) => (
              <div key={p.code} role="row" data-testid={`plan-${p.name}`} className="grid grid-cols-2 py-3 md:grid-cols-12 md:items-center md:py-0">
                <span role="cell" className={`${CELL} col-span-2 text-[15px] font-semibold text-foreground md:col-span-2 md:text-[14px]`}>{p.name}</span>
                <span role="cell" className={`${CELL} col-span-2 text-muted-foreground md:col-span-3`}>{p.bestFor}</span>
                <span role="cell" className={`${CELL} text-foreground md:col-span-1`}><span className={MOBILE_LABEL}>{C.entities}</span>{p.entities}</span>
                <span role="cell" className={`${CELL} text-foreground md:col-span-2`}><span className={MOBILE_LABEL}>{C.users}</span>{p.namedUsers}</span>
                <span role="cell" className={`${CELL} col-span-2 text-foreground md:col-span-2`}><span className={MOBILE_LABEL}>{C.price}</span>{p.proposedAmount}</span>
                <span role="cell" className={`${CELL} col-span-2 md:col-span-2`}>
                  {SERVICE_ENQUIRY_SURFACES.contactRoute ? (
                    <Link to={activationHref(p.code, "landing_plans")} data-testid={`plan-action-${p.name}`} className="inline-flex whitespace-nowrap text-[13px] font-semibold text-foreground underline underline-offset-4 hover:no-underline">
                      {p.contactSales ? LANDING_PLANS_COPY.enterpriseAction : REQUEST_ACTIVATION_LABEL}
                    </Link>
                  ) : (
                    <span data-testid={p.contactSales ? "enterprise-unavailable" : `plan-unavailable-${p.name}`} className="text-[12px] text-muted-foreground">
                      {p.contactSales ? LANDING_PLANS_COPY.enterpriseUnavailable : LANDING_PLANS_COPY.requestUnavailable}
                    </span>
                  )}
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground" data-testid={`plan-activation-note-${p.name}`}>{LANDING_PLANS_COPY.activationNote}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
