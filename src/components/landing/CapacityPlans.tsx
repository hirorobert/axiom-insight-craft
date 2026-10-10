/**
 * CapacityPlans — the CAPACITY decision. Entities, named users and additional users come from the reviewed catalogue
 * (PROPOSED_PLANS / PRICING_CATALOGUE). What a row says about price and payment comes from planPurchaseView() over the
 * server's public prices, passed in by the page (this component reads nothing itself):
 *   - an approved price with online payment open → that price and "Choose <plan>" (the signed-in checkout);
 *   - otherwise → the catalogue figure marked "Proposed" and "Request activation" (the enquiry preselected with the plan).
 * Enterprise is always "Discuss Enterprise". The applicable notes are stated once, under the table.
 *
 * One structure for every width: an ARIA table that lays out as rows on wide screens and as stacked cards on phones.
 */

import { Link } from "react-router-dom";
import { LANDING_PLANS_COPY } from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";
import { PRICING_CATALOGUE } from "@/lib/commercial/pricingCatalogue";
import { additionalUserLine, planPurchaseView, type PublicPrices } from "@/lib/commercial/planOffers";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

const C = LANDING_PLANS_COPY.columns;
const CELL = "px-4 py-2 md:py-4 text-[13px] leading-5";
const MOBILE_LABEL = "md:hidden block text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground";

export function CapacityPlans({ prices = null }: { prices?: PublicPrices | null } = {}) {
  const rows = PROPOSED_PLANS.map((p) => {
    const plan = PRICING_CATALOGUE.find((c) => c.code === p.code)!;
    return { p, view: planPurchaseView(plan, prices, "landing_plans"), extraUsers: additionalUserLine(plan) };
  });
  const anyOnline = rows.some((r) => r.view.mode === "online");
  const anyProposed = rows.some((r) => r.view.priceLines.some((l) => l.startsWith("Proposed")));
  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-20 border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-10 lg:py-20">
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
            {rows.map(({ p, view, extraUsers }) => (
              <div key={p.code} role="row" data-testid={`plan-${p.name}`} data-mode={view.mode} className="grid grid-cols-2 py-3 md:grid-cols-12 md:items-center md:py-0">
                <span role="cell" className={`${CELL} col-span-2 text-[15px] font-semibold text-foreground md:col-span-2 md:text-[14px]`}>{p.name}</span>
                <span role="cell" className={`${CELL} col-span-2 text-muted-foreground md:col-span-3`}>{p.bestFor}</span>
                <span role="cell" className={`${CELL} text-foreground md:col-span-1`}><span className={MOBILE_LABEL}>{C.entities}</span>{p.entities}</span>
                <span role="cell" className={`${CELL} text-foreground md:col-span-2`}>
                  <span className={MOBILE_LABEL}>{C.users}</span>{p.namedUsers}
                  {extraUsers && <span className="mt-1 block text-[11px] leading-4 text-muted-foreground" data-testid={`plan-extra-users-${p.name}`}>{extraUsers}</span>}
                </span>
                <span role="cell" className={`${CELL} col-span-2 text-foreground md:col-span-2`} data-testid={`plan-price-${p.name}`}>
                  <span className={MOBILE_LABEL}>{C.price}</span>
                  {view.priceLines.map((line) => <span key={line} className="block">{line}</span>)}
                </span>
                <span role="cell" className={`${CELL} col-span-2 md:col-span-2`}>
                  {view.mode === "online" || SERVICE_ENQUIRY_SURFACES.contactRoute ? (
                    <Link to={view.href} data-testid={`plan-action-${p.name}`} className="inline-flex whitespace-nowrap text-[13px] font-semibold text-foreground underline underline-offset-4 hover:no-underline">
                      {view.actionLabel}
                    </Link>
                  ) : (
                    <span data-testid={p.contactSales ? "enterprise-unavailable" : `plan-unavailable-${p.name}`} className="text-[12px] text-muted-foreground">
                      {p.contactSales ? LANDING_PLANS_COPY.enterpriseUnavailable : LANDING_PLANS_COPY.requestUnavailable}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 space-y-1 text-[12px] leading-5 text-muted-foreground" data-testid="plans-notes">
          {anyProposed && <p data-testid="plans-activation-note">{LANDING_PLANS_COPY.activationNote}</p>}
          {anyOnline && <p data-testid="plans-online-note">{LANDING_PLANS_COPY.onlineNote}</p>}
        </div>
      </div>
    </section>
  );
}
