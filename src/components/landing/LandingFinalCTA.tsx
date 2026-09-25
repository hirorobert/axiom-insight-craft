/**
 * LandingFinalCTA — one closing action. High contrast through type and a thin border rather than
 * a dark full-bleed band, and no price, timing or card claim of any kind.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_FINAL_CTA } from "@/content/landing/landingContent";

export function LandingFinalCTA() {
  return (
    <section aria-labelledby="final-cta-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
        <div className="border border-border bg-muted/25 px-6 py-10 sm:px-10 sm:py-12">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="final-cta-title"
              className="text-xl font-semibold tracking-[-0.03em] text-foreground sm:text-2xl lg:text-[1.75rem]"
            >
              {LANDING_FINAL_CTA.heading}
            </h2>
            <p className="mt-3 text-xs leading-6 text-muted-foreground sm:text-sm">
              {LANDING_FINAL_CTA.supporting}
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button variant="hero" size="lg" asChild className="w-full sm:w-auto sm:min-w-[168px]">
                <Link to={LANDING_FINAL_CTA.primaryCta.href}>
                  {LANDING_FINAL_CTA.primaryCta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button variant="outline" size="lg" asChild className="w-full sm:w-auto">
                <Link to={LANDING_FINAL_CTA.secondaryCta.href}>
                  {LANDING_FINAL_CTA.secondaryCta.label}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
