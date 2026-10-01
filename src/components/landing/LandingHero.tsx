/**
 * LandingHero — the proposition and exactly two actions: one primary (Create account) and one
 * secondary that goes straight to the service chooser, where the visitor picks what they need.
 *
 * No illustrative status panel: a static, fictional progress list proved nothing and pushed the
 * actual decision (which service, at what size) below the fold. The hero is deliberately compact so
 * the service chooser begins inside the first viewport on a laptop screen.
 */

import { ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_HERO, LANDING_SERVICES } from "@/content/landing/landingContent";

export function LandingHero() {
  return (
    <section aria-labelledby="hero-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-12 pt-24 lg:px-10 lg:pb-14 lg:pt-28">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_HERO.eyebrow}</p>
        <h1
          id="hero-title"
          className="mt-5 max-w-3xl text-[2.1rem] font-semibold leading-[1.05] tracking-[-0.04em] text-foreground sm:text-[2.75rem] lg:text-[3.25rem]"
        >
          {LANDING_HERO.headline}
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-7 text-muted-foreground sm:text-base">{LANDING_HERO.supporting}</p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button variant="hero" size="lg" asChild className="w-full sm:w-auto sm:min-w-[176px]">
            <Link to={LANDING_HERO.primaryCta.href}>
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

        {/* The four services, named once — each a link into the chooser. */}
        <ul className="mt-12 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4" aria-label="Services at a glance">
          {LANDING_SERVICES.map((s) => (
            <li key={s.id} className="bg-background">
              <a
                href={LANDING_HERO.secondaryCta.href}
                className="flex h-full flex-col gap-1 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="text-[13px] font-semibold text-foreground">{s.name}</span>
                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">{s.tierLabel}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
