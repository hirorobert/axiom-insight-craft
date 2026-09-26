import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { BRAND, PRICING, PRICING_TABLE } from "@/constants/copy";
import {
  MATRIX_CAPABILITIES,
  NO_CHECKOUT_NOTICE,
  PRICING_CATALOGUE,
  annualSavingMinor,
  formatCatalogueAmount,
  matrixCapabilityName,
  planIncludes,
  type CataloguePlan,
} from "@/lib/commercial/pricingCatalogue";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

// ─────────────────────────────────────────────────────────────
// /pricing — CFO Close plans.
//
// Every name, capacity, price and included capability comes from the one catalogue (src/lib/commercial/
// pricingCatalogue.ts), which mirrors the plans, offers and plan x capability matrix in 20260925100000 / 20260925130000.
// There is no free plan and no trial. Prices never authorize anything: the database checks the
// capabilities and capacity of the plan actually held. There is no checkout in this build, so paid plans say
// plainly how to upgrade today instead of showing a payment button, and the page links to the contact form only
// when that route actually exists.
// ─────────────────────────────────────────────────────────────

type BillingInterval = "monthly" | "annual";

// The same honest wording the upgrade button uses: there is no checkout (no provider named, no invented contact).
const CHECKOUT_UNAVAILABLE = NO_CHECKOUT_NOTICE;

function PriceBlock({ plan, interval }: { plan: CataloguePlan; interval: BillingInterval }) {
  if (plan.salesMode === "contact_sales" || plan.monthlyMinor === null || plan.annualMinor === null) {
    return (
      <div data-testid={`price-${plan.code}`}>
        <p className="text-3xl font-semibold tracking-tight text-foreground">Custom</p>
        <p className="mt-1 text-xs text-muted-foreground">Annual terms agreed with our team</p>
      </div>
    );
  }
  const saving = annualSavingMinor(plan);
  return (
    <div data-testid={`price-${plan.code}`}>
      {interval === "monthly" ? (
        <p className="text-3xl font-semibold tracking-tight text-foreground">
          {formatCatalogueAmount(plan.monthlyMinor)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/ month</span>
        </p>
      ) : (
        <p className="text-3xl font-semibold tracking-tight text-foreground">
          {formatCatalogueAmount(plan.annualMinor)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/ year</span>
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {interval === "monthly"
          ? `or ${formatCatalogueAmount(plan.annualMinor)} / year`
          : saving !== null && saving > 0
            ? `Saves ${formatCatalogueAmount(saving)} against monthly billing`
            : `or ${formatCatalogueAmount(plan.monthlyMinor)} / month`}
      </p>
      <SeatLine plan={plan} interval={interval} />
    </div>
  );
}

// Included named users and the separately priced additional seat — never folded into the base price.
function SeatLine({ plan, interval }: { plan: CataloguePlan; interval: BillingInterval }) {
  if (!plan.additionalSeat) return null;
  const amount = interval === "monthly" ? `${formatCatalogueAmount(plan.additionalSeat.monthlyMinor)} / month` : `${formatCatalogueAmount(plan.additionalSeat.annualMinor)} / year`;
  return (
    <p className="mt-2 text-xs text-foreground/80" data-testid={`seat-price-${plan.code}`}>
      Includes {plan.includedSeats} named user. Additional named users {amount} each.
    </p>
  );
}

function PlanAction({ plan, contactAvailable }: { plan: CataloguePlan; contactAvailable: boolean }) {
  const label = plan.salesMode === "contact_sales" ? "Contact sales" : `Talk to us about ${plan.name}`;
  return (
    <div>
      {contactAvailable ? (
        <Button asChild variant={plan.code === "PRACTICE" ? "default" : "outline"} className="w-full">
          <Link to="/contact">{label} <ArrowRight className="h-4 w-4" /></Link>
        </Button>
      ) : (
        <p className="border border-dashed border-border px-3 py-2 text-center text-xs font-medium text-foreground">
          {plan.salesMode === "contact_sales" ? "Contact sales through your CFO Close account team" : `Request ${plan.name} from our team`}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{CHECKOUT_UNAVAILABLE}</p>
    </div>
  );
}

export default function Pricing() {
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const contactAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />

      <main className="flex-1 px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center sm:mb-14">
            <p className="mb-4 text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground/60">
              {BRAND.name} · Pricing
            </p>
            <h1 className="mb-4 text-3xl font-bold leading-tight text-foreground sm:text-4xl">
              Plans that grow with your portfolio.
            </h1>
            <p className="mx-auto max-w-xl text-sm leading-relaxed text-muted-foreground">
              Every plan certifies, issues and analyses the close; plans differ by entities and named users. There is
              no free plan and no trial. Prices in {PRICING.CURRENCY_CODE}.
            </p>
          </div>

          <div className="mb-8 flex justify-center sm:mb-10">
            <div className="inline-flex border border-border" role="group" aria-label="Billing interval">
              {(["monthly", "annual"] as const).map((value, i) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setInterval(value)}
                  aria-pressed={interval === value}
                  className={`px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:px-6 ${
                    i > 0 ? "border-l border-border " : ""
                  }${interval === value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                >
                  {value === "monthly" ? "Monthly" : "Annual"}
                </button>
              ))}
            </div>
          </div>

          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
            {PRICING_CATALOGUE.map((plan) => (
              <li
                key={plan.code}
                data-testid={`plan-${plan.code}`}
                className={`flex min-w-0 flex-col border bg-card p-5 sm:p-6 ${plan.code === "PRACTICE" ? "border-foreground" : "border-border"}`}
              >
                <h2 className="text-base font-semibold text-foreground">{plan.name}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground md:min-h-[2.5rem]">{plan.tagline}</p>
                <div className="mt-4">
                  <PriceBlock plan={plan} interval={interval} />
                </div>
                <ul className="mt-5 flex-1 space-y-2" aria-label={`${plan.name} includes`}>
                  {plan.highlights.map((h) => (
                    <li key={h} className="flex gap-2 text-xs leading-5 text-foreground/80">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  <PlanAction plan={plan} contactAvailable={contactAvailable} />
                </div>
              </li>
            ))}
          </ul>

          <section className="mt-12 border border-border bg-muted/20 p-5 sm:p-6" aria-labelledby="always-included">
            <h2 id="always-included" className="text-sm font-semibold text-foreground">In every plan</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Every plan includes trial balance upload, classification, reconciliation, validation, statement preview and
              comparative reporting; comparative periods are never charged separately. If a plan ends, existing data and
              every output already issued stay readable; new work pauses until a plan is in place, and people beyond the
              plan's named users are suspended, never removed, until you choose who stays active.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground" data-testid="named-user-policy">
              Every person who uses {BRAND.name} signs in with their own account. A named user is one person, so the work
              recorded under a sign-in belongs to that person.
            </p>
          </section>

          <section className="mt-10" aria-labelledby="plan-matrix">
            <h2 id="plan-matrix" className="text-sm font-semibold text-foreground">What each plan includes</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-xs" data-testid="plan-capability-matrix">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-2 pr-3 font-medium text-muted-foreground">Capability</th>
                    {PRICING_CATALOGUE.map((p) => (
                      <th key={p.code} scope="col" className="px-2 py-2 text-center font-medium text-foreground">{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_CAPABILITIES.map((c) => (
                    <tr key={c} className="border-b border-border/60">
                      <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground/80">{matrixCapabilityName(c)}</th>
                      {PRICING_CATALOGUE.map((p) => (
                        <td key={p.code} className="px-2 py-2 text-center text-foreground/80">
                          {planIncludes(p.code, c) ? <Check className="mx-auto h-3.5 w-3.5" aria-label="Included" /> : <span aria-label="Not included">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <dl className="mt-8 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {PRICING_TABLE.map((row) => (
              <div key={row.term} className="border-t border-border pt-3">
                <dt className="text-xs font-semibold text-foreground">{row.term}</dt>
                <dd className="mt-1 text-xs leading-5 text-muted-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-center text-[11px] text-muted-foreground">{PRICING.TAX_DISCLAIMER}</p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
