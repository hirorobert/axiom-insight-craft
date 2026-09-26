import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { BRAND } from "@/constants/copy";
import { NO_CHECKOUT_NOTICE } from "@/lib/commercial/pricingCatalogue";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

// ─────────────────────────────────────────────────────────────
// /request-access — where every "Request access" action leads (security correction B-7).
//
// There is no self-serve sign-up to a working workspace and no checkout: a plan is activated by the team. So "Request
// access" never sends a visitor to ordinary sign-up (which would reach a blocked, plan-less workspace). When the
// request form is enabled (the service-enquiry gate), this page sends the request through it; otherwise it says
// plainly how access works and invents no contact details.
// ─────────────────────────────────────────────────────────────
export default function RequestAccess() {
  const formAvailable = SERVICE_ENQUIRY_SURFACES.contactRoute && SERVICE_ENQUIRY_SURFACES.submissionAllowed;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="flex-1 px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
        <div className="mx-auto max-w-xl" data-testid="request-access">
          <p className="mb-4 text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground/60">{BRAND.name} · Access</p>
          <h1 className="mb-4 text-3xl font-bold leading-tight text-foreground">Request access</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {BRAND.name} is activated by our team for each organisation: we confirm the plan, the entities and the named
            users with you, then open the workspace. {NO_CHECKOUT_NOTICE}
          </p>
          {formAvailable ? (
            <div className="mt-6">
              <Button asChild>
                <Link to="/contact" data-testid="request-access-form-link">Send an access request <ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>
          ) : (
            <p className="mt-6 border border-dashed border-border px-4 py-3 text-sm text-foreground" data-testid="request-access-offline">
              Access requests are handled by the {BRAND.name} team through your account contact. The online request form is not
              open in this deployment yet.
            </p>
          )}
          <p className="mt-8 text-xs text-muted-foreground">
            Already activated? <Link to="/auth" className="underline underline-offset-2">Sign in</Link>.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
