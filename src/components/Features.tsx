import { ArrowRight, LockKeyhole, ScanSearch, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DELIVERABLES,
  JURISDICTION_SECTION,
  METHOD,
  PRICING,
  PRICING_SECTION,
  SECURITY_HEADLINE,
  SECURITY_SUBHEAD,
} from "@/constants/copy";

function SectionHeader({
  label,
  title,
  detail,
}: {
  label: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 border-b border-border pb-10 lg:grid-cols-12 lg:gap-12">
      <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground lg:col-span-4">
        {label}
      </p>
      <div className="lg:col-span-8">
        <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
          {title}
        </h2>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          {detail}
        </p>
      </div>
    </div>
  );
}

export function Features() {
  return (
    <div className="bg-background">
      <section id="method" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
          <SectionHeader
            label="Operating method"
            title="A shorter path to a defensible result."
            detail="CFOClose separates source evidence, professional decisions and issued outputs. The interface advances one consequential action at a time."
          />

          <ol className="grid grid-cols-1 border-b border-border md:grid-cols-2 xl:grid-cols-4">
            {METHOD.map((step, index) => (
              <li
                key={step.number}
                className={[
                  "py-8 md:px-7 xl:min-h-64",
                  index > 0 ? "border-t border-border md:border-l md:border-t-0" : "",
                  index === 2 ? "md:border-l-0 md:border-t xl:border-l xl:border-t-0" : "",
                ].join(" ")}
              >
                <p className="text-[10px] font-mono text-muted-foreground/55">{step.number}</p>
                <h3 className="mt-8 text-base font-semibold text-foreground">{step.title}</h3>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="deliverables" className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
          <SectionHeader
            label="Deliverables"
            title="The work remains visible after the engine finishes."
            detail="Every output is presented as a professional work product with the decisions, exceptions and source context required to review it."
          />

          <dl className="grid grid-cols-1 border-b border-border sm:grid-cols-2 lg:grid-cols-3">
            {DELIVERABLES.map(([term, detail], index) => (
              <div
                key={term}
                className={[
                  "border-t border-border py-7 sm:px-6",
                  index % 2 === 1 ? "sm:border-l" : "",
                  index % 3 !== 0 ? "lg:border-l" : "lg:border-l-0",
                ].join(" ")}
              >
                <dt className="text-sm font-semibold text-foreground">{term}</dt>
                <dd className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="security" className="border-b border-border bg-primary text-primary-foreground">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/45">
                Control boundary
              </p>
              <h2 className="mt-6 max-w-xl text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                {SECURITY_HEADLINE}
              </h2>
              <p className="mt-5 max-w-xl text-sm leading-6 text-primary-foreground/60">
                {SECURITY_SUBHEAD}
              </p>
            </div>

            <div className="grid grid-cols-1 border-t border-primary-foreground/20 sm:grid-cols-3 lg:col-span-7">
              {[
                {
                  icon: LockKeyhole,
                  title: "Identity",
                  detail: "Writes are tied to the authenticated session—not a name supplied by the browser.",
                },
                {
                  icon: ScanSearch,
                  title: "Uncertainty",
                  detail: "Missing, unresolved and unavailable facts remain explicit instead of becoming guessed values.",
                },
                {
                  icon: ShieldCheck,
                  title: "Authority",
                  detail: "Sensitive transitions occur through controlled server boundaries and remain independently testable.",
                },
              ].map((item, index) => {
                const Icon = item.icon;
                return (
                  <article
                    key={item.title}
                    className={`border-b border-primary-foreground/20 py-8 sm:px-6 ${index > 0 ? "sm:border-l" : ""}`}
                  >
                    <Icon className="h-5 w-5 text-primary-foreground/65" strokeWidth={1.5} />
                    <h3 className="mt-8 text-sm font-semibold">{item.title}</h3>
                    <p className="mt-3 text-xs leading-5 text-primary-foreground/55">{item.detail}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section id="coverage" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
          <SectionHeader
            label="Framework and jurisdiction"
            title="Capability is declared. Never implied."
            detail="The selected reporting framework and jurisdiction determine which preparation and compliance capabilities appear inside an engagement."
          />
          <div className="grid grid-cols-1 divide-y divide-border border-b border-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            {JURISDICTION_SECTION.items.map((item, index) => (
              <article key={item.label} className="py-8 lg:px-8">
                <p className="text-[10px] font-mono text-muted-foreground/55">0{index + 1}</p>
                <h3 className="mt-6 text-sm font-semibold text-foreground">{item.label}</h3>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{item.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="border-b border-border bg-muted/20">
        <div className="mx-auto grid max-w-7xl grid-cols-1 lg:grid-cols-12">
          <div className="px-6 py-16 lg:col-span-8 lg:px-10 lg:py-20">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Professional plan</p>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-foreground">
              {PRICING_SECTION.headline}
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">{PRICING_SECTION.subhead}</p>
          </div>
          <div className="border-t border-border bg-background px-6 py-10 lg:col-span-4 lg:border-l lg:border-t-0 lg:px-10 lg:py-16">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">From</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
              {PRICING.CURRENCY_CODE} {PRICING.ANNUAL_USD}
              <span className="text-sm font-normal text-muted-foreground"> / year</span>
            </p>
            <p className="mt-2 text-xs text-muted-foreground">Monthly option: USD {PRICING.MONTHLY_USD}. Exact availability is verified before checkout.</p>
            <Button variant="hero" className="mt-7 w-full" asChild>
              <Link to={PRICING_SECTION.ctaHref}>
                Review plan
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
