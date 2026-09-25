import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Header } from "@/components/Header";
import { LandingHero } from "@/components/landing/LandingHero";
import { CoreCapabilities } from "@/components/landing/CoreCapabilities";
import { ControlledCloseAndAssurance } from "@/components/landing/ControlledCloseAndAssurance";
import { VerifiedDeliverables } from "@/components/landing/VerifiedDeliverables";
import { CommercialVerification } from "@/components/landing/CommercialVerification";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCTA } from "@/components/landing/LandingFinalCTA";
import { Footer } from "@/components/Footer";
import { AuthLinkErrorScreen, getAuthLinkError } from "@/components/AuthLinkErrorScreen";

// ─── Page composition ────────────────────────────────────────────────────────
//  1. Header
//  2. Hero — proposition and actions on the left, synthetic status preview on the right,
//            so product proof sits inside the first viewport rather than below a tall
//            text-only band.
//  3. Core capabilities
//  4. Controlled-close process, combined with the Close Assurance control layer
//  5. Verified deliverables — only outputs reachable in the current interface
//  6. Commercial structure, under final enforcement verification
//  7. FAQ — the same data the FAQPage structured data in index.html is built from
//  8. Final call to action
//  9. Footer
// ─────────────────────────────────────────────────────────────────────────────

const Index = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // A repeat/expired confirmation-link click lands here with an auth error in
  // the URL hash — show a friendly explanation instead of a silent redirect.
  const authLinkError = getAuthLinkError(window.location.hash);

  // Authenticated users go directly to the workspace — never see the marketing page.
  useEffect(() => {
    if (!loading && user) {
      navigate("/dashboard", { replace: true });
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
        <CoreCapabilities />
        <ControlledCloseAndAssurance />
        <VerifiedDeliverables />
        <CommercialVerification />
        <LandingFAQ />
        <LandingFinalCTA />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
