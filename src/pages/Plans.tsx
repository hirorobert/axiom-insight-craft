import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AccountOrPublicFrame } from "@/components/account/AccountOrPublicFrame";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";
import { BillingHelpLine } from "@/components/contact/ContactChannels";
import { planByCode } from "@/lib/commercial/pricingCatalogue";
import { getCheckoutOptions, usePublicPlanPrices } from "@/lib/commercial/checkoutClient";
import { SERVICE_INTENTS, parsePlanIntent, parseServiceIntent, serviceAvailabilityLabel } from "@/lib/commercial/serviceIntent";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Account-aware purchase entry: the public price read says whether payment is open to EVERYONE; a signed-in account may
 * additionally be allowed by the server (e.g. the allow-listed tester during LIVE_ACCEPTANCE). Only the server's own
 * checkout-options answer for this session can open the entry point; any error or refusal keeps the public answer.
 * The checkout page and POST re-check authorization per plan.
 */
function useAccountCheckoutOpen(userId: string | null): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!userId) return;
    let live = true;
    getCheckoutOptions("SOLO").then(({ data, error }) => {
      if (live && !error && data?.options?.some((o) => o.available === true)) setOpen(true);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [userId]);
  return open;
}

export default function Plans() {
  // The service chosen on the public page, carried here when the account has no plan that includes it. Validated
  // against the closed registry; it only tells the visitor what they came for — it grants nothing.
  const [params] = useSearchParams();
  const service = parseServiceIntent(params.get("service"));
  const plan = service ? parsePlanIntent(params.get("plan")) : null;
  const publicPrices = usePublicPlanPrices();
  const { user } = useAuth();
  const accountOpen = useAccountCheckoutOpen((user as { id?: string } | null)?.id ?? null);
  const prices = publicPrices && accountOpen && !publicPrices.onlinePayment ? { ...publicPrices, onlinePayment: true } : publicPrices;
  return <AccountOrPublicFrame publicMainClassName="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-28 sm:px-5" accountMainClassName="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-5"><p className="text-xs uppercase text-muted-foreground">CFOClose · Plans</p><h1 className="mt-3 text-3xl font-semibold text-foreground">Choose your plan</h1><p className="mt-3 mb-10 max-w-2xl text-sm text-muted-foreground">Plans differ in how many entities and named users they cover. Every plan is a 12-month term and does not renew automatically.</p>{service && <div data-testid="plans-selected-service" className="mb-8 max-w-2xl border-l-2 border-foreground bg-muted/30 px-4 py-3 text-sm text-foreground"><p className="font-semibold">You chose {SERVICE_INTENTS[service].name}{plan ? ` · ${planByCode(plan)?.name} plan` : ""}.</p><p className="mt-1 text-muted-foreground">{serviceAvailabilityLabel(service)}. Choose the capacity you need; once the plan is active you go straight to it.</p></div>}<PlanCatalogue source="plan_wall" prices={prices} /><BillingHelpLine className="mt-10 justify-center" /></AccountOrPublicFrame>;
}
