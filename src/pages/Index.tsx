import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { PainPoints } from "@/components/PainPoints";
import { ProductTour } from "@/components/ProductTour";
import { Features } from "@/components/Features";
import { ClosingCTA } from "@/components/ClosingCTA";
import { Footer } from "@/components/Footer";
import { AuthLinkErrorScreen, getAuthLinkError } from "@/components/AuthLinkErrorScreen";

// ─── Page composition ────────────────────────────────────────────────────────
// Section order follows conversion architecture:
//  1. Hero        — what it is, trust metrics, immediate CTAs
//  2. PainPoints  — before/after contrast that earns attention
//  3. ProductTour — outcome selector: what specifically does it produce?
//  4. Features    — method, deliverables, security, jurisdiction, pricing
//  5. ClosingCTA  — one last conversion moment before the footer
//  6. Footer
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
      <Header />
      <main>
        <Hero />
        <PainPoints />
        <ProductTour />
        <Features />
        <ClosingCTA />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
