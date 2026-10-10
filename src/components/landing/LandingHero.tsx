/**
 * LandingHero — one proposition, one primary action ("Explore plans", to the plans), a secondary activation request
 * (the preselected enquiry), and one genuine, labelled product screenshot. The brand appears once, in the header.
 */

import { ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BRAND_GOLD, BRAND_NAVY } from "@/components/CFOCloseWordmark";
import { LANDING_HERO } from "@/content/landing/landingContent";
import { activationRequestHref } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function LandingHero() {
  const shot = LANDING_HERO.screenshot;
  return (
    <section aria-labelledby="hero-title" className="border-b border-border text-white" style={{ backgroundColor: BRAND_NAVY }}>
      <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-14 pt-24 sm:px-6 lg:grid-cols-12 lg:items-center lg:px-10 lg:pb-16 lg:pt-28">
        <div className="lg:col-span-5">
          <p className="text-[11px] font-mono uppercase tracking-[0.22em]" style={{ color: BRAND_GOLD }}>{LANDING_HERO.eyebrow}</p>
          <h1 id="hero-title" className="mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.035em] text-white sm:text-[2.75rem] lg:text-[2.9rem]">
            {LANDING_HERO.headline}
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-7 text-white/85 sm:text-base">{LANDING_HERO.supporting}</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg" asChild className="w-full rounded-none text-[#0D1D3B] hover:opacity-90 sm:w-auto sm:min-w-[200px]" style={{ backgroundColor: BRAND_GOLD }}>
              <a href={LANDING_HERO.primaryCta.href} data-testid="hero-explore-plans">
                {LANDING_HERO.primaryCta.label}
                <ArrowDown className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
            {SERVICE_ENQUIRY_SURFACES.contactRoute && (
              <Button size="lg" variant="outline" asChild className="w-full rounded-none border-white/50 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">
                <Link to={activationRequestHref("landing_plans")} data-testid="hero-request-activation">
                  {LANDING_HERO.secondaryCta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            )}
          </div>
        </div>

        <figure className="min-w-0 lg:col-span-7" data-testid="hero-screenshot">
          <img
            src={shot.src}
            width={shot.width}
            height={shot.height}
            alt={shot.alt}
            loading="eager"
            decoding="async"
            className="h-auto w-full border border-white/20 bg-white shadow-xl"
          />
          <figcaption className="mt-2 text-[12px] text-white/75" data-testid="hero-screenshot-caption">{shot.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
