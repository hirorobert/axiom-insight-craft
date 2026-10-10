/**
 * LandingFinalCTA — the closing action after the questions: "Request activation" (the activation enquiry) and Sign in.
 * States plainly that terms are agreed first and there is no online payment.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BRAND_GOLD, BRAND_NAVY } from "@/components/CFOCloseWordmark";
import { LANDING_FINAL_CTA } from "@/content/landing/landingContent";
import { activationRequestHref } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function LandingFinalCTA() {
  return (
    <section aria-labelledby="final-cta-title" className="text-white" style={{ backgroundColor: BRAND_NAVY }}>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-16">
        <div>
          <h2 id="final-cta-title" className="text-2xl font-semibold tracking-[-0.03em] sm:text-[2rem]">{LANDING_FINAL_CTA.heading}</h2>
          <p className="mt-2 text-sm text-white/75">{LANDING_FINAL_CTA.supporting}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          {SERVICE_ENQUIRY_SURFACES.contactRoute && (
            <Button size="lg" asChild className="rounded-none text-[#0D1D3B] hover:opacity-90" style={{ backgroundColor: BRAND_GOLD }}>
              <Link to={activationRequestHref("landing_plans")} data-testid="final-request-activation">
                {LANDING_FINAL_CTA.primaryCta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
          <Button size="lg" variant="outline" asChild className="rounded-none border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white">
            <Link to={LANDING_FINAL_CTA.secondaryCta.href} data-testid="final-sign-in">{LANDING_FINAL_CTA.secondaryCta.label}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
