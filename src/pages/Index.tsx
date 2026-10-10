import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Header } from "@/components/Header";
import { LandingHero } from "@/components/landing/LandingHero";
import { SoftwareSection } from "@/components/landing/SoftwareSection";
import { SpecialistServices } from "@/components/landing/SpecialistServices";
import { CapacityPlans } from "@/components/landing/CapacityPlans";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCTA } from "@/components/landing/LandingFinalCTA";
import { currentServiceIntent } from "@/lib/commercial/serviceIntent";
import { Footer } from "@/components/Footer";
import { AuthLinkErrorScreen, getAuthLinkError } from "@/components/AuthLinkErrorScreen";
import { takeCheckoutPlan, usePublicPlanPrices } from "@/lib/commercial/checkoutClient";
import { checkoutHref, parseCheckoutPlan } from "@/lib/commercial/planOffers";

// ─── Page composition ────────────────────────────────────────────────────────
//  1. Header
//  2. Hero — the proposition, "Explore plans" (primary), an activation request, and one labelled product screenshot
//  3. Choose your outcome + what you receive (single-select service; three outputs; one action)
//  4. Choose your capacity — plans from the catalogue; price and action per plan from the server's public prices
//  5. Trust — three assurances in registered wording
//  6. FAQ — the same data the FAQPage structured data in index.html is built from — then the final action
//  7. Footer — the disclosures, stated once, at the foot of the page
// The selected service travels with every call to action as a validated `service=` identifier.
// ─────────────────────────────────────────────────────────────────────────────

const Index = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  // The server's public prices decide, per plan, between an approved price with "Choose <plan>" and "Proposed" with
  // "Request activation" (src/lib/commercial/planOffers.ts). Until they are read, every plan shows the proposed form.
  const prices = usePublicPlanPrices();

  // A repeat/expired confirmation-link click lands here with an auth error in
  // the URL hash — show a friendly explanation instead of a silent redirect.
  const authLinkError = getAuthLinkError(window.location.hash);

  // Authenticated users go directly to the workspace — never see the marketing page.
  useEffect(() => {
    if (!loading && user) {
      // A visitor who chose a plan before signing up / in continues to that plan's checkout (plan code only, one use).
      const checkoutPlan = takeCheckoutPlan(parseCheckoutPlan);
      if (checkoutPlan) { navigate(checkoutHref(checkoutPlan), { replace: true }); return; }
      // A validated service intent (e.g. from the confirmation link) is forwarded to the gateway.
      const intent = currentServiceIntent(window.location.search);
      navigate(intent ? `/dashboard?service=${intent.service}${intent.plan ? `&plan=${intent.plan.toLowerCase()}` : ""}` : "/dashboard", { replace: true });
    }
  }, [user, loading, navigate]);

  // Auth link errors (consumed/expired confirmation link) take priority over
  // both the marketing page and the signed-in redirect.
  if (authLinkError) {
    return <AuthLinkErrorScreen linkError={authLinkError} />;
  }

  // Suppress flash — render nothing while auth resolves or redirect is in flight.
  if (loading || user) return null;

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        Skip to main content
      </a>
      <Header />
      <main id="main-content">
        <LandingHero />
        <SoftwareSection />
        <CapacityPlans prices={prices} />
        <SpecialistServices />
        <TrustStrip />
        <LandingFAQ />
        <LandingFinalCTA />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
