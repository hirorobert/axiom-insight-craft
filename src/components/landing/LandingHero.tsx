/**
 * LandingHero — the proposition and exactly two actions: Create account (carrying the selected service) and
 * "Explore a sample close", which goes to the outcome chooser. Below them, a compact service selector: choosing a
 * service here selects it in the chooser and scrolls there. No fictional progress panel.
 */

import { ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_HERO, LANDING_SERVICES } from "@/content/landing/landingContent";
import { serviceAuthHref } from "@/lib/commercial/serviceIntent";
import { useLandingIntent } from "@/components/landing/landingIntentContext";

export function LandingHero() {
  const { service, setService } = useLandingIntent();
  return (
    <section aria-labelledby="hero-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-12 pt-24 lg:px-10 lg:pb-14 lg:pt-28">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_HERO.eyebrow}</p>
        <h1
          id="hero-title"
          className="mt-5 max-w-4xl text-[2.1rem] font-semibold leading-[1.05] tracking-[-0.04em] text-foreground sm:text-[2.75rem] lg:text-[3.25rem]"
        >
          {LANDING_HERO.headline}
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-7 text-muted-foreground sm:text-base">{LANDING_HERO.supporting}</p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button variant="hero" size="lg" asChild className="w-full sm:w-auto sm:min-w-[176px]">
            <Link to={serviceAuthHref("signup", service)} data-testid="hero-create-account">
              {LANDING_HERO.primaryCta.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button variant="outline" size="lg" asChild className="w-full sm:w-auto">
            <a href={LANDING_HERO.secondaryCta.href}>
              {LANDING_HERO.secondaryCta.label}
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </div>

        {/* Compact service selector — selects the outcome below and goes there. */}
        <nav aria-label="Choose a service" className="mt-12">
          <ul className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
            {LANDING_SERVICES.map((s) => (
              <li key={s.id} className="bg-background">
                <a
                  href="#services"
                  onClick={() => setService(s.id)}
                  aria-current={service === s.id ? "true" : undefined}
                  data-testid={`hero-service-${s.id}`}
                  className={`flex h-full items-center justify-between gap-2 px-4 py-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    service === s.id ? "bg-foreground text-background" : "text-foreground hover:bg-muted/40"
                  }`}
                >
                  {s.name}
                  <ArrowDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
