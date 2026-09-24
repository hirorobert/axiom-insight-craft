/**
 * LandingHero — value proposition on the left, the synthetic status preview on the right.
 *
 * The preview is part of the hero composition rather than a section below it, so meaningful
 * product proof is inside the first viewport at 1440x900 and 1024x768. At 768px and below the
 * copy stacks above the preview.
 *
 * Exactly two actions: one primary (sign up) and one quiet secondary (jump to the preview).
 * No trust strip, no decorative panel, no dark full-bleed aside.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_HERO } from "@/content/landing/landingContent";
import { SyntheticClosePreview } from "@/components/landing/SyntheticClosePreview";

export function LandingHero() {
  return (
    <section
      id="sample-close"
      aria-labelledby="hero-title"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto max-w-7xl px-6 pb-12 pt-20 lg:px-10 lg:pb-14 lg:pt-24">
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-12">

          {/* ── Left: proposition + actions ──────────────────────────────── */}
          <div className="lg:col-span-6 xl:col-span-6">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
              {LANDING_HERO.eyebrow}
            </p>

            <h1
              id="hero-title"
              className="mt-5 max-w-xl text-[2rem] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[2.5rem] lg:text-[2.75rem]"
            >
              {LANDING_HERO.headline}
            </h1>

            <p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
              {LANDING_HERO.supporting}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button variant="hero" size="lg" asChild className="w-full sm:w-auto sm:min-w-[168px]">
                <Link to={LANDING_HERO.primaryCta.href}>
                  {LANDING_HERO.primaryCta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button variant="outline" size="lg" asChild className="w-full sm:w-auto">
                <a href={LANDING_HERO.secondaryCta.href}>{LANDING_HERO.secondaryCta.label}</a>
              </Button>
            </div>
          </div>

          {/* ── Right: synthetic status preview ──────────────────────────── */}
          <div className="lg:col-span-6 xl:col-span-6">
            <SyntheticClosePreview />
          </div>
        </div>
      </div>
    </section>
  );
}
