/**
 * CheckoutUpgradeButton — Ω2-G
 *
 * Initiates checkout via server-side Edge Function. Browser never sets
 * payment state, price, or currency. Iron Dome: planCode only -> server
 * resolves the commercial offer -> server creates intent -> redirect.
 * Return URL carries only saffReference. Entitlement only from server commit.
 *
 * Global-neutral display: shows whatever offer the server resolves for
 * this plan (GLOBAL market by default) — never a hardcoded Tanzania price,
 * never a client-side currency conversion. If no offer is configured yet,
 * this renders a clear "not yet available" state instead of a broken or
 * fabricated price.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2 } from "lucide-react";
import { createCheckoutIntent, callCommercialRpc } from "@/lib/commercial/commercialRpc";
import { supabase } from "@/integrations/supabase/client";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { moneyToDisplay, type CurrencyCode } from "@/lib/commercial/payments/money";
import { toast } from "sonner";

interface Props {
  billingStatus: LicenceStatus | null;
  /**
   * Ω3-CHECKOUT trust boundary: the ONLY two billing intervals the charter
   * authorizes. Mandatory — never defaulted here or anywhere downstream.
   * Threaded, unmodified, into BOTH the display-resolution call and the
   * checkout-creation call below, exactly like `marketCode` (see its own
   * doc comment) — DISPLAY_INTERVAL must always equal CHECKOUT_INTERVAL.
   */
  billingInterval: "MONTHLY" | "ANNUAL";
  /**
   * The customer's CURRENT plan code (e.g. "FREE"), from the same
   * get_my_billing_summary() read that supplies `billingStatus`. Required
   * to tell "already on the plan this button offers" apart from "on a
   * different, lower plan that also happens to have an ACTIVE licence" —
   * Ω1 auto-provisions every new signup with a FREE licence in ACTIVE
   * status, so `billingStatus` alone can never distinguish a genuine FREE
   * customer from a genuine PAID one. `null`/`undefined` (billing summary
   * not yet loaded, or no billing customer at all) never suppresses the
   * button on its own — only a CONFIRMED match against `planCode` does.
   */
  currentPlanCode?: string | null;
  /** Plan the upgrade button targets. Defaults to the paid firm-licence plan. */
  planCode?: string;
  /**
   * Explicit, caller-supplied commercial market code (e.g. "TZ"). SAFF has
   * no authoritative persisted commercial-market source for a customer or
   * workspace today — this is NEVER derived here from accounting
   * jurisdiction, entity/company country, user locale, or currency. Those
   * are different concepts entirely (accounting jurisdiction governs
   * statutory tax rules; commercial market governs pricing/offer
   * selection) and conflating them would silently encode a guess into a
   * financial-commerce decision.
   *
   * Omitting this prop (undefined) is not a TZ default and never becomes
   * one: it resolves to the neutral 'GLOBAL' market on the server, exactly
   * as passing "GLOBAL" explicitly would. The identical value is threaded
   * into BOTH the display resolution (resolve_commercial_offer) and the
   * checkout creation (commercial-create-checkout) calls below, so the
   * customer can never see one market's economics and then check out
   * against a different one (DISPLAY_MARKET == CHECKOUT_MARKET). A future
   * Pricing page with a real market-selection UI can pass a genuine value
   * through this same prop with no further plumbing changes.
   */
  marketCode?: string;
}

type OfferDisplayState =
  | { phase: "LOADING" }
  | { phase: "AVAILABLE"; label: string; intervalLabel: string }
  | { phase: "UNAVAILABLE" };

/** Shape of resolve_commercial_offer()'s response this component reads. */
export interface ResolvedOfferData {
  resolution?: string;
  amount_minor?: number | null;
  currency_code?: string;
  currency_exponent?: number;
  billing_interval?: string;
  billing_interval_count?: number;
}

export function intervalLabelFor(interval: string | undefined, count: number | undefined): string {
  const n = count ?? 1;
  switch (interval) {
    case "MONTHLY": return `/ ${n > 1 ? `${n} months` : "month"}`;
    case "ONE_TIME": return "one-time";
    default: return `/ ${n > 1 ? `${n} years` : "year"}`;
  }
}

/**
 * Pure derivation of the offer display state from resolve_commercial_
 * offer()'s response. Fails closed to UNAVAILABLE (never a fabricated
 * price/checkout action) for anything other than an explicit AVAILABLE
 * resolution carrying both a real amount_minor and currency_code — a
 * missing/null/undefined response, NOT_AVAILABLE, AMBIGUOUS, UNKNOWN, or
 * an AVAILABLE resolution missing its own economic fields all resolve the
 * same way: no upgrade action is shown.
 */
export function deriveOfferDisplayState(data: ResolvedOfferData | null | undefined): OfferDisplayState {
  if (data?.resolution === "AVAILABLE" && data.amount_minor != null && data.currency_code) {
    const label = moneyToDisplay({
      amountMinor: BigInt(data.amount_minor),
      currencyCode: data.currency_code as CurrencyCode,
      exponent: data.currency_exponent ?? 2,
    });
    return {
      phase: "AVAILABLE",
      label,
      intervalLabel: intervalLabelFor(data.billing_interval, data.billing_interval_count),
    };
  }
  return { phase: "UNAVAILABLE" };
}

/**
 * Ω2 checkout entry-point gap (root cause, pure decision extracted for
 * testability): suppressing the upgrade action on `billingStatus` alone
 * treated every FREE customer as "already paid" — Ω1 auto-provisions a
 * FREE licence in ACTIVE status for every new signup, so
 * `billingStatus === "ACTIVE"` is true for FREE and PAID customers alike.
 * The action is suppressed ONLY when the customer is CONFIRMED to already
 * be on THIS button's own target plan; a null/unknown `currentPlanCode`
 * (billing summary not yet loaded, or no billing customer at all) never
 * suppresses it on its own — fail OPEN toward showing the real
 * server-resolved offer state, never fail toward silently hiding a
 * legitimate upgrade path.
 */
export function shouldShowUpgradeAction(
  currentPlanCode: string | null | undefined,
  targetPlanCode: string,
  billingStatus: LicenceStatus | null,
): boolean {
  const alreadyOnThisPlan = currentPlanCode != null && currentPlanCode === targetPlanCode;
  const licenceIsCurrent = billingStatus === "ACTIVE" || billingStatus === "GRACE";
  return !(alreadyOnThisPlan && licenceIsCurrent);
}

export function CheckoutUpgradeButton({ billingStatus, currentPlanCode = null, planCode = "PAID", billingInterval, marketCode }: Props) {
  const [loading, setLoading] = useState(false);
  const [offer, setOffer] = useState<OfferDisplayState>({ phase: "LOADING" });
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Same `marketCode`/`billingInterval` values used for display
      // resolution here are reused, unmodified, in handleUpgrade()'s
      // createCheckoutIntent call below — this is what guarantees
      // DISPLAY_MARKET == CHECKOUT_MARKET and DISPLAY_INTERVAL ==
      // CHECKOUT_INTERVAL. Do not let these calls diverge onto separately-
      // derived values.
      const { data } = await callCommercialRpc("resolve_commercial_offer", {
        p_plan_code: planCode,
        p_billing_interval: billingInterval,
        p_market_code: marketCode,
      });
      if (cancelled) return;
      setOffer(deriveOfferDisplayState(data));
    })();
    return () => { cancelled = true; };
  }, [planCode, billingInterval, marketCode]);

  if (!shouldShowUpgradeAction(currentPlanCode, planCode, billingStatus)) {
    return (
      <p className="text-xs text-muted-foreground">
        Your plan is active. Contact support to change or renew.
      </p>
    );
  }

  async function handleUpgrade() {
    setLoading(true);
    try {
      // Authenticated checkout CTA: an anonymous visitor (e.g. on the
      // public /pricing page) is sent to sign in first, rather than
      // reaching the Edge Function only to be told "Not authenticated" —
      // this is a UX improvement only; createCheckoutIntent's own
      // session check remains the real, authoritative gate regardless.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/auth");
        return;
      }

      const { data, error } = await createCheckoutIntent(planCode, billingInterval, marketCode);

      if (error || !data) {
        toast.error(error ?? "Could not start checkout. Please try again.");
        return;
      }

      // Redirect to provider-hosted checkout.
      // Return URL is server-set — browser never controls the return destination.
      window.location.href = data.checkoutUrl;
    } catch {
      toast.error("Checkout failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (offer.phase === "UNAVAILABLE") {
    return (
      <p className="text-xs text-muted-foreground">
        Upgrade is not yet available. Please contact us for firm licensing.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {offer.phase === "AVAILABLE" && (
        <p className="text-sm font-medium text-center">{offer.label} {offer.intervalLabel}</p>
      )}
      <Button onClick={handleUpgrade} disabled={loading || offer.phase === "LOADING"} className="w-full gap-2">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {loading ? "Preparing checkout…" : "Upgrade Plan"}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Secure payment. Your licence activates automatically after
        server-side payment verification.
      </p>
    </div>
  );
}
