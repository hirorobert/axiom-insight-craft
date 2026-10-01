import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Header } from "@/components/Header";
import { LandingHero } from "@/components/landing/LandingHero";
import { ServiceChooser } from "@/components/landing/ServiceChooser";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { Footer } from "@/components/Footer";
import { AuthLinkErrorScreen, getAuthLinkError } from "@/components/AuthLinkErrorScreen";

// ─── Page composition ────────────────────────────────────────────────────────
//  1. Header
//  2. Hero — the proposition, two actions and the four services named once
//  3. Service chooser — the one decision: services (included / paid), what they produce,
//     the proposed plan sizes and the single closing action
//  4. FAQ — the same data the FAQPage structured data in index.html is built from
//  5. Footer — the disclosures, stated once, at the foot of the page
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
        <ServiceChooser />
        <LandingFAQ />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
