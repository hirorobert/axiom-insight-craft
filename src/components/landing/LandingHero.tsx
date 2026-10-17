/**
 * LandingHero — one proposition, one primary action ("See a sample review", to the illustrative sample on this page) and
 * the plans as the secondary action. The brand appears once, in the header. The earlier product screenshot is gone: at its
 * rendered desktop size (about half scale) its text was unreadable, so it showed the product without explaining it.
 */

import { ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BRAND_MINT, BRAND_SLATE } from "@/components/CFOCloseWordmark";
import { LANDING_HERO } from "@/content/landing/landingContent";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function LandingHero() {
  return (
    <section aria-labelledby="hero-title" className="border-b border-border text-white" style={{ backgroundColor: BRAND_SLATE }}>
      <div className="mx-auto max-w-4xl px-4 pb-14 pt-24 sm:px-6 lg:pb-16 lg:pt-28">
        <p className="text-[11px] font-mono uppercase tracking-[0.22em]" style={{ color: BRAND_MINT }}>{LANDING_HERO.eyebrow}</p>
        <h1 id="hero-title" className="mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.035em] text-white sm:text-[2.75rem] lg:text-[3.1rem]">
          {LANDING_HERO.headline}
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-white/85 sm:text-[17px]">{LANDING_HERO.supporting}</p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button size="lg" asChild className="w-full rounded-sm text-[#2E2F3A] hover:opacity-90 sm:w-auto sm:min-w-[200px]" style={{ backgroundColor: BRAND_MINT }}>
            <a href={LANDING_HERO.primaryCta.href} data-testid="hero-sample">
              {LANDING_HERO.primaryCta.label}
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
          {SERVICE_ENQUIRY_SURFACES.contactRoute && (
            <Button size="lg" variant="outline" asChild className="w-full rounded-none border-white/50 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">
              <Link to="/plans" data-testid="hero-view-plans">
                {LANDING_HERO.secondaryCta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
