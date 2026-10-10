/**
 * SoftwareSection — what the subscription includes (Trial balance review: its outputs and three-step workflow) and the
 * one pilot (Financial reporting), labelled as a pilot by invitation that is not generally available and whose accounting
 * has not been independently validated. Nothing here can be bought or started: activation is requested in the plans.
 */

import { LANDING_PILOT, LANDING_SERVICES, LANDING_SERVICES_COPY, LANDING_WORKFLOW, type LandingServiceOutput } from "@/content/landing/landingContent";

function OutputRow({ o }: { o: LandingServiceOutput }) {
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <span className="min-w-0 text-[14px] leading-5 text-foreground">{o.name}</span>
      <span className="shrink-0 text-[11px] font-mono text-muted-foreground">{o.formats}</span>
    </li>
  );
}

export function SoftwareSection() {
  const service = LANDING_SERVICES[0];
  return (
    <section id="software" aria-labelledby="software-title" className="scroll-mt-20 border-b border-border bg-muted/20">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:px-10 lg:py-20">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_SERVICES_COPY.eyebrow}</p>
          <h2 id="software-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">{LANDING_SERVICES_COPY.heading}</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{LANDING_SERVICES_COPY.intro}</p>
        </div>

        <div className="mt-10 grid grid-cols-1 border border-border bg-background lg:grid-cols-12" data-testid="software-included">
          <div className="border-b border-border p-6 lg:col-span-5 lg:border-b-0 lg:border-r lg:p-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground" data-testid="software-included-label">{LANDING_SERVICES_COPY.includedLabel}</p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-foreground">{service.name}</h3>
            <p className="mt-2 text-[14px] leading-6 text-muted-foreground">{service.outcome}</p>
            <p className="mt-3 text-[15px] leading-6 text-foreground">{service.value}</p>
          </div>
          <div className="p-6 lg:col-span-7 lg:p-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">{LANDING_SERVICES_COPY.outputsHeading}</p>
            <ul className="mt-1" data-testid="primary-outputs">
              {service.primaryOutputs.map((o) => <OutputRow key={o.name} o={o} />)}
            </ul>
            <p className="mt-6 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">{LANDING_SERVICES_COPY.workflowHeading}</p>
            <ol className="mt-3 space-y-2" data-testid="service-workflow">
              {LANDING_WORKFLOW.map((step, i) => (
                <li key={step} className="flex items-baseline gap-3 text-[14px] leading-5 text-foreground">
                  <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <p className="mt-5 text-[12px] leading-5 text-foreground" data-testid="software-formats">{LANDING_SERVICES_COPY.formats}</p>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{LANDING_SERVICES_COPY.frameworks}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 border border-dashed border-border bg-background p-6 sm:flex-row sm:items-baseline sm:gap-6" data-testid="software-pilot">
          <p className="shrink-0 text-[15px] font-semibold text-foreground">{LANDING_PILOT.name}</p>
          <p className="shrink-0 text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">{LANDING_PILOT.label}</p>
          <p className="text-[13px] leading-5 text-muted-foreground">{LANDING_PILOT.text}</p>
        </div>
      </div>
    </section>
  );
}
