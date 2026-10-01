/**
 * ServiceChooser — the one decision surface of the landing page. It merges what used to be four
 * sections (capabilities, deliverables, commercial structure and the closing call to action) into
 * a single choice:
 *
 *   1. pick the services you need (each says plainly whether it is included in every plan or paid);
 *   2. see exactly what those services produce, and in which formats;
 *   3. compare the proposed plan sizes (every plan includes every service — plans differ in entity
 *      and named-user capacity);
 *   4. one action: Create account. Plans are activated by the team; online payment is off.
 *
 * Local presentation state only: no network, storage, clock or backend import. Selecting a service
 * or a plan size activates nothing — it shapes what the visitor reads before creating an account.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LANDING_FINAL_CTA,
  LANDING_SERVICES,
  LANDING_SERVICES_COPY,
  type LandingService,
} from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";

type ServiceId = LandingService["id"];

function TierChip({ service }: { service: LandingService }) {
  const paid = service.tier === "paid";
  return (
    <span
      data-testid={`tier-${service.id}`}
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
        paid ? "bg-foreground text-background" : "border border-border text-muted-foreground"
      }`}
    >
      {service.tierLabel}
    </span>
  );
}

export function ServiceChooser() {
  const [selected, setSelected] = useState<ReadonlySet<ServiceId>>(() => new Set<ServiceId>(["preparation", "reporting"]));
  const [plan, setPlan] = useState<string>(PROPOSED_PLANS[1]?.name ?? PROPOSED_PLANS[0].name);

  const toggle = (service: LandingService) => {
    if (service.tier === "included") return; // part of every plan; cannot be removed
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(service.id)) next.delete(service.id);
      else next.add(service.id);
      return next;
    });
  };
  const chosen = LANDING_SERVICES.filter((s) => selected.has(s.id));
  const outputCount = chosen.reduce((n, s) => n + s.outputs.length, 0);

  return (
    <section id="services" aria-labelledby="services-title" className="scroll-mt-20 border-b border-border bg-muted/20">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:px-10 lg:py-20">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_SERVICES_COPY.eyebrow}</p>
          <h2 id="services-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">
            {LANDING_SERVICES_COPY.heading}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{LANDING_SERVICES_COPY.intro}</p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-10">
          {/* ── Services ───────────────────────────────────────────────── */}
          <ul className="grid grid-cols-1 content-start gap-3 self-start sm:grid-cols-2 lg:sticky lg:top-24 lg:col-span-7" aria-label="Services">
            {LANDING_SERVICES.map((service) => {
              const on = selected.has(service.id);
              const locked = service.tier === "included";
              return (
                <li key={service.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-describedby={`service-${service.id}-outcome`}
                    data-testid={`service-${service.id}`}
                    onClick={() => toggle(service)}
                    className={`group flex h-full w-full flex-col bg-background p-5 text-left transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      on ? "border-2 border-foreground p-[19px] shadow-[0_1px_0_0_hsl(var(--foreground)/0.06)]" : "border border-border hover:border-foreground/40"
                    } ${locked ? "cursor-default" : ""}`}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <TierChip service={service} />
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center border ${
                          on ? "border-foreground bg-foreground text-background" : "border-border text-transparent group-hover:border-foreground/40"
                        }`}
                      >
                        {locked ? <Lock className="h-3 w-3" /> : <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                      </span>
                    </span>
                    <span className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-foreground">{service.name}</span>
                    <span id={`service-${service.id}-outcome`} className="mt-2 text-[13px] leading-5 text-muted-foreground">
                      {service.outcome}
                    </span>
                    <span className="mt-auto pt-5 text-[11px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
                      {locked ? "Always included" : on ? "Selected" : "Select"} · {service.outputs.length} {service.outputs.length === 1 ? "output" : "outputs"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* ── What you receive · plan size · action ──────────────────── */}
          <aside aria-label="Your selection" className="self-start lg:col-span-5">
            <div className="border border-border bg-background">
              <div className="border-b border-border px-5 py-4">
                <p className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-semibold text-foreground">{LANDING_SERVICES_COPY.outputsHeading}</span>
                  <span className="text-[11px] font-mono text-muted-foreground" data-testid="output-count">{outputCount} outputs</span>
                </p>
              </div>
              <div className="px-5 py-2" data-testid="selected-outputs">
                {chosen.map((service) => (
                  <div key={service.id} className="py-3">
                    <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground">{service.name}</p>
                    <ul className="mt-2 space-y-1.5">
                      {service.outputs.map((o) => (
                        <li key={o.name} className="flex items-baseline justify-between gap-4">
                          <span className="min-w-0 text-[13px] leading-5 text-foreground">
                            {o.name}
                            {o.condition && <span className="block text-[11px] leading-4 text-muted-foreground">{o.condition}</span>}
                          </span>
                          <span className="shrink-0 text-[11px] font-mono text-muted-foreground">{o.formats}</span>
                        </li>
                      ))}
                    </ul>
                    {service.controls && (
                      <ul className="mt-2 space-y-1">
                        {service.controls.map((c) => (
                          <li key={c} className="flex gap-2 text-[11px] leading-4 text-muted-foreground">
                            <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            {c}
                          </li>
                        ))}
                      </ul>
                    )}
                    {service.note && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{service.note}</p>}
                  </div>
                ))}
              </div>

              <fieldset id="plans" className="scroll-mt-24 border-t border-border px-5 py-4">
                <legend className="sr-only">{LANDING_SERVICES_COPY.plansHeading}</legend>
                <p aria-hidden="true" className="text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
                  {LANDING_SERVICES_COPY.plansHeading}
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PROPOSED_PLANS.map((p) => {
                    const on = plan === p.name;
                    return (
                      <label
                        key={p.name}
                        data-testid={`plan-${p.name}`}
                        className={`relative flex cursor-pointer flex-col px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 ${
                          on ? "border-2 border-foreground px-[11px] py-[9px]" : "border border-border hover:border-foreground/40"
                        }`}
                      >
                        <input type="radio" name="plan-size" value={p.name} checked={on} onChange={() => setPlan(p.name)} className="sr-only" />
                        <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
                        <span className="mt-0.5 text-[11px] leading-4 text-foreground">{p.proposedAmount}</span>
                        <span className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{p.capacitySummary}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="border-t border-border px-5 py-5">
                <Button variant="hero" size="lg" asChild className="w-full">
                  <Link to={LANDING_FINAL_CTA.primaryCta.href} data-testid="chooser-create-account">
                    {LANDING_FINAL_CTA.primaryCta.label}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
                <p className="mt-3 text-center text-[11px] leading-4 text-muted-foreground" data-testid="chooser-activation-note">
                  {LANDING_FINAL_CTA.supporting} You can confirm the {plan} plan with our team after you sign up.
                </p>
                <p className="mt-3 flex items-center justify-center gap-4 text-[12px]">
                  <Link to={LANDING_FINAL_CTA.secondaryCta.href} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    {LANDING_FINAL_CTA.secondaryCta.label}
                  </Link>
                  <span aria-hidden="true" className="text-border">|</span>
                  <Link to={LANDING_SERVICES_COPY.comparePlans.href} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    {LANDING_SERVICES_COPY.comparePlans.label}
                  </Link>
                </p>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">{LANDING_SERVICES_COPY.frameworks}</p>
          </aside>
        </div>
      </div>
    </section>
  );
}
