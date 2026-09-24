import { ArrowRight, LockKeyhole, ScanSearch, ShieldCheck, CheckCircle2 } from "lucide-react";
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
  TRUST_GUARANTEES,
} from "@/constants/copy";

function SectionLabel({ text }: { text: string }) {
  return (
    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
      {text}
    </p>
  );
}

export function Features() {
  return (
    <div className="bg-background">

      {/* ── Method: 4-step operating process ──────────────────────────── */}
      <section id="method" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

          <div className="mb-8 flex flex-col gap-3 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionLabel text="Operating method" />
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                A shorter path to a defensible result.
              </h2>
            </div>
            <p className="max-w-sm text-sm text-muted-foreground">
              CFOClose separates source evidence, professional decisions and issued outputs.
              The interface advances one consequential action at a time.
            </p>
          </div>

          <ol className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
            {METHOD.map((step) => (
              <li key={step.number} className="bg-background p-6">
                <p className="text-[10px] font-mono text-muted-foreground/45">{step.number}</p>
                <h3 className="mt-5 text-sm font-semibold text-foreground">{step.title}</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Deliverables ───────────────────────────────────────────────── */}
      <section id="deliverables" className="border-b border-border bg-muted/15">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

          <div className="mb-8 flex flex-col gap-3 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionLabel text="Deliverables" />
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                The work remains visible after the engine finishes.
              </h2>
            </div>
            <p className="max-w-sm text-sm text-muted-foreground">
              Every output carries the decisions, exceptions and source context required to review it.
            </p>
          </div>

          <dl className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {DELIVERABLES.map(([term, detail]) => (
              <div key={term} className="bg-background p-5">
                <dt className="text-sm font-semibold text-foreground">{term}</dt>
                <dd className="mt-1.5 text-xs leading-5 text-muted-foreground">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Security / Control boundary ────────────────────────────────── */}
      <section id="security" className="border-b border-border bg-primary text-primary-foreground">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

          {/* Top row */}
          <div className="grid grid-cols-1 gap-8 border-b border-primary-foreground/15 pb-10 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/40">
                Control boundary
              </p>
              <h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
                {SECURITY_HEADLINE}
              </h2>
              <p className="mt-4 text-sm leading-6 text-primary-foreground/60">
                {SECURITY_SUBHEAD}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-px border border-primary-foreground/10 bg-primary-foreground/10 sm:grid-cols-3 lg:col-span-7">
              {[
                {
                  icon: LockKeyhole,
                  title: "Identity",
                  detail: "Writes are tied to the authenticated server session—not a name supplied by the browser.",
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
              ].map(({ icon: Icon, title, detail }) => (
                <article key={title} className="bg-primary p-6">
                  <Icon className="h-5 w-5 text-primary-foreground/55" strokeWidth={1.5} />
                  <h3 className="mt-5 text-sm font-semibold">{title}</h3>
                  <p className="mt-2 text-xs leading-5 text-primary-foreground/50">{detail}</p>
                </article>
              ))}
            </div>
          </div>

          {/* Financial integrity guarantees */}
          <div className="pt-10">
            <p className="mb-6 text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/40">
              Financial integrity guarantees
            </p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {TRUST_GUARANTEES.map((g) => (
                <li key={g} className="flex items-start gap-3 text-xs leading-5 text-primary-foreground/65">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2} />
                  {g}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Jurisdiction coverage ──────────────────────────────────────── */}
      <section id="coverage" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

          <div className="mb-8 flex flex-col gap-3 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionLabel text="Framework and jurisdiction" />
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                Capability is declared. Never implied.
              </h2>
            </div>
            <p className="max-w-sm text-sm text-muted-foreground">
              The selected framework and jurisdiction determine which capabilities appear inside an engagement.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-px border border-border bg-border lg:grid-cols-3">
            {JURISDICTION_SECTION.items.map(({ label, detail }, i) => (
              <article key={label} className="bg-background p-6">
                <p className="text-[10px] font-mono text-muted-foreground/45">0{i + 1}</p>
                <h3 className="mt-4 text-sm font-semibold text-foreground">{label}</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing CTA ───────────────────────────────────────────────── */}
      <section id="pricing" className="border-b border-border bg-muted/15">
        <div className="mx-auto max-w-7xl px-6 lg:px-10">
          <div className="grid grid-cols-1 lg:grid-cols-12">

            {/* Left */}
            <div className="py-10 lg:col-span-7 lg:py-14 lg:pr-10">
              <SectionLabel text="Professional plan" />
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                {PRICING_SECTION.headline}
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                {PRICING_SECTION.subhead}
              </p>
            </div>

            {/* Right — price card */}
            <div className="flex flex-col justify-center border-t border-border bg-background px-0 py-8 lg:col-span-5 lg:border-l lg:border-t-0 lg:px-10">
              <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
                {PRICING.ENTRY_PLAN_NAME} from
              </p>
              <div className="mt-2 flex items-baseline gap-1.5">
                <p className="text-4xl font-semibold tracking-tight text-foreground">
                  {PRICING.ENTRY_ANNUAL}
                </p>
                <span className="text-sm text-muted-foreground">/ year</span>
                <span className="ml-1 border border-success/30 bg-success/8 px-2 py-0.5 text-[10px] font-semibold text-success">
                  SAVE {PRICING.ENTRY_ANNUAL_SAVING}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Monthly option: {PRICING.ENTRY_MONTHLY}. Prices in {PRICING.CURRENCY_CODE}. Free plan available.
              </p>
              <Button variant="hero" className="mt-6 w-full sm:w-auto" asChild>
                <Link to={PRICING_SECTION.ctaHref}>
                  Compare plans
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
