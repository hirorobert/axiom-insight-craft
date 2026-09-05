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
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2 } from "lucide-react";
import { createCheckoutIntent, callCommercialRpc } from "@/lib/commercial/commercialRpc";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { moneyToDisplay, type CurrencyCode } from "@/lib/commercial/payments/money";
import { toast } from "sonner";

interface Props {
  billingStatus: LicenceStatus | null;
  /** Plan the upgrade button targets. Defaults to the paid firm-licence plan. */
  planCode?: string;
}

type OfferDisplayState =
  | { phase: "LOADING" }
  | { phase: "AVAILABLE"; label: string; intervalLabel: string }
  | { phase: "UNAVAILABLE" };

function intervalLabelFor(interval: string | undefined, count: number | undefined): string {
  const n = count ?? 1;
  switch (interval) {
    case "MONTHLY": return `/ ${n > 1 ? `${n} months` : "month"}`;
    case "ONE_TIME": return "one-time";
    default: return `/ ${n > 1 ? `${n} years` : "year"}`;
  }
}

export function CheckoutUpgradeButton({ billingStatus, planCode = "PAID" }: Props) {
  const [loading, setLoading] = useState(false);
  const [offer, setOffer] = useState<OfferDisplayState>({ phase: "LOADING" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await callCommercialRpc("resolve_commercial_offer", { p_plan_code: planCode });
      if (cancelled) return;
      if (data?.resolution === "AVAILABLE" && data.amount_minor != null && data.currency_code) {
        const label = moneyToDisplay({
          amountMinor: BigInt(data.amount_minor),
          currencyCode: data.currency_code as CurrencyCode,
          exponent: data.currency_exponent ?? 2,
        });
        setOffer({
          phase: "AVAILABLE",
          label,
          intervalLabel: intervalLabelFor(data.billing_interval, data.billing_interval_count),
        });
      } else {
        setOffer({ phase: "UNAVAILABLE" });
      }
    })();
    return () => { cancelled = true; };
  }, [planCode]);

  if (billingStatus === "ACTIVE" || billingStatus === "GRACE") {
    return (
      <p className="text-xs text-muted-foreground">
        Your plan is active. Contact support to change or renew.
      </p>
    );
  }

  async function handleUpgrade() {
    setLoading(true);
    try {
      const { data, error } = await createCheckoutIntent(planCode);

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
