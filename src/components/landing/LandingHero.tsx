/**
 * LandingHero — the brand panel and one proposition, with one request: "Request activation" (the preselected activation
 * enquiry) and a way to the plans. Manual activation is stated beside the actions. No service strip, no progress panel.
 */

import { ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BRAND_GOLD, BRAND_NAVY, CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { LANDING_HERO } from "@/content/landing/landingContent";
import { activationRequestHref, MANUAL_ACTIVATION_NOTE } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function LandingHero() {
  return (
    <section aria-labelledby="hero-title" className="border-b border-border text-white" style={{ backgroundColor: BRAND_NAVY }}>
      <div className="mx-auto max-w-7xl px-6 pb-14 pt-24 lg:px-10 lg:pb-16 lg:pt-28">
        <CFOCloseWordmark variant="panel" className="px-0 text-[1.6rem] sm:text-[2rem]" />
        <p className="mt-8 text-[11px] font-mono uppercase tracking-[0.22em]" style={{ color: BRAND_GOLD }}>{LANDING_HERO.eyebrow}</p>
        <h1 id="hero-title" className="mt-4 max-w-4xl text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.035em] text-white sm:text-[2.75rem] lg:text-[3.1rem]">
          {LANDING_HERO.headline}
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-7 text-white/80 sm:text-base">{LANDING_HERO.supporting}</p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          {SERVICE_ENQUIRY_SURFACES.contactRoute && (
            <Button size="lg" asChild className="w-full rounded-none text-[#0D1D3B] hover:opacity-90 sm:w-auto sm:min-w-[200px]" style={{ backgroundColor: BRAND_GOLD }}>
              <Link to={activationRequestHref("landing_plans")} data-testid="hero-request-activation">
                {LANDING_HERO.primaryCta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
          <Button size="lg" variant="outline" asChild className="w-full rounded-none border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">
            <a href={LANDING_HERO.secondaryCta.href} data-testid="hero-see-plans">
              {LANDING_HERO.secondaryCta.label}
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </div>
        <p className="mt-4 text-[13px] text-white/70" data-testid="hero-activation-note">{MANUAL_ACTIVATION_NOTE}</p>
      </div>
    </section>
  );
}
