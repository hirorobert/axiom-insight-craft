/**
 * LandingFinalCTA — the closing action after the questions: Create account (carrying the selected service) and View
 * plans. States plainly that plans are activated by the team and online payment is not available.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LANDING_FINAL_CTA } from "@/content/landing/landingContent";
import { serviceAuthHref } from "@/lib/commercial/serviceIntent";
import { useLandingIntent } from "@/components/landing/landingIntentContext";

export function LandingFinalCTA() {
  const { service } = useLandingIntent();
  return (
    <section aria-labelledby="final-cta-title" className="bg-foreground text-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-16">
        <div>
          <h2 id="final-cta-title" className="text-2xl font-semibold tracking-[-0.03em] sm:text-[2rem]">{LANDING_FINAL_CTA.heading}</h2>
          <p className="mt-2 text-sm text-background/70">{LANDING_FINAL_CTA.supporting}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" asChild className="rounded-none bg-background text-foreground hover:bg-background/90">
            <Link to={serviceAuthHref("signup", service)} data-testid="final-create-account">
              {LANDING_FINAL_CTA.primaryCta.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="rounded-none border-background/40 bg-transparent text-background hover:bg-background/10 hover:text-background">
            <a href={LANDING_FINAL_CTA.secondaryCta.href}>{LANDING_FINAL_CTA.secondaryCta.label}</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
