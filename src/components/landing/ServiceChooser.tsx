/**
 * ServiceChooser — the OUTCOME decision: which service the visitor needs. Plans (capacity) are a separate decision in
 * CapacityPlans below; nothing here is priced and nothing is a basket.
 *
 *   · Four single-select cards (a native radio group: one choice, arrow-key navigation). Each states its availability
 *     as derived from the plan × capability matrix (serviceAvailabilityLabel) — never "free", never "paid capability".
 *   · "What you receive" for the selected service: one value statement, at most three primary outputs, the rest behind
 *     "See all included outputs", and one action that carries the choice into sign-up as a validated `service=`.
 *
 * Selection is navigational intent only. No network, storage, clock or backend import.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_SERVICES, LANDING_SERVICES_COPY, type LandingServiceOutput } from "@/content/landing/landingContent";
import { serviceAuthHref, serviceAvailabilityLabel } from "@/lib/commercial/serviceIntent";
import { useLandingIntent } from "@/components/landing/landingIntentContext";

function OutputRow({ o }: { o: LandingServiceOutput }) {
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <span className="min-w-0 text-[14px] leading-5 text-foreground">
        {o.name}
        {o.condition && <span className="mt-0.5 block text-[12px] leading-4 text-muted-foreground">{o.condition}</span>}
      </span>
      <span className="shrink-0 text-[11px] font-mono text-muted-foreground">{o.formats}</span>
    </li>
  );
}

export function ServiceChooser() {
  const { service, setService } = useLandingIntent();
  const selected = LANDING_SERVICES.find((s) => s.id === service) ?? LANDING_SERVICES[0];

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

        {/* ── The outcome: one choice ─────────────────────────────────────── */}
        <fieldset className="mt-10">
          <legend className="sr-only">{LANDING_SERVICES_COPY.heading}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {LANDING_SERVICES.map((s) => {
              const on = s.id === selected.id;
              return (
                <label
                  key={s.id}
                  data-testid={`service-${s.id}`}
                  data-selected={on}
                  className={`relative flex cursor-pointer flex-col bg-background p-5 transition-[border-color] focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
                    on ? "border-2 border-foreground p-[19px]" : "border border-border hover:border-foreground/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="landing-service"
                    value={s.id}
                    checked={on}
                    onChange={() => setService(s.id)}
                    className="sr-only"
                    aria-describedby={`service-${s.id}-outcome`}
                  />
                  <span className="flex items-start justify-between gap-3">
                    <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{s.name}</span>
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border ${on ? "border-[5px] border-foreground" : "border-border"}`}
                    />
                  </span>
                  <span id={`service-${s.id}-outcome`} className="mt-2 text-[13px] leading-5 text-muted-foreground">{s.outcome}</span>
                  <span className="mt-auto pt-4 text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground" data-testid={`availability-${s.id}`}>
                    {serviceAvailabilityLabel(s.id)}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* ── What the chosen outcome produces ─────────────────────────────── */}
        <div
          id="outputs"
          aria-live="polite"
          className="mt-6 grid scroll-mt-24 grid-cols-1 border border-border bg-background lg:grid-cols-12"
          data-testid="service-preview"
        >
          <div className="border-b border-border p-6 lg:col-span-5 lg:border-b-0 lg:border-r lg:p-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">{LANDING_SERVICES_COPY.outputsHeading}</p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-foreground">{selected.name}</h3>
            <p className="mt-3 text-[15px] leading-6 text-foreground">{selected.value}</p>
            {selected.note && <p className="mt-3 text-[12px] leading-5 text-muted-foreground">{selected.note}</p>}
            <Button variant="hero" size="lg" asChild className="mt-6 w-full sm:w-auto">
              <Link to={serviceAuthHref("signup", selected.id)} data-testid="service-start">
                {LANDING_SERVICES_COPY.startPrefix} {selected.name}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <p className="mt-3 text-[12px] text-muted-foreground">
              {LANDING_SERVICES_COPY.signInPrompt}{" "}
              <Link to={serviceAuthHref("login", selected.id)} className="text-foreground underline-offset-4 hover:underline" data-testid="service-sign-in">
                {LANDING_SERVICES_COPY.signInLabel}
              </Link>
            </p>
          </div>
          <div className="p-6 lg:col-span-7 lg:p-8">
            <ul data-testid="primary-outputs">
              {selected.primaryOutputs.map((o) => <OutputRow key={o.name} o={o} />)}
            </ul>
            {selected.moreOutputs.length > 0 && (
              <details key={selected.id} className="group mt-4" data-testid="more-outputs">
                <summary className="cursor-pointer list-none text-[13px] font-medium text-foreground underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
                  {LANDING_SERVICES_COPY.seeAll} ({selected.moreOutputs.length})
                </summary>
                <ul className="mt-2">
                  {selected.moreOutputs.map((o) => <OutputRow key={o.name} o={o} />)}
                </ul>
              </details>
            )}
            <p className="mt-5 text-[11px] leading-4 text-muted-foreground">{LANDING_SERVICES_COPY.frameworks}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
