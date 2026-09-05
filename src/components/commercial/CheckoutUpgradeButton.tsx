/**
 * CheckoutUpgradeButton — Ω2
 *
 * Initiates checkout via server-side Edge Function. Browser never sets payment state.
 * Iron Dome: planId only → server derives price → server creates intent → redirect.
 * Return URL carries only saffReference. Entitlement only from server commit.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2 } from "lucide-react";
import { createCheckoutIntent } from "@/lib/commercial/commercialRpc";
import { supabase } from "@/integrations/supabase/client";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { toast } from "sonner";

interface Props {
  billingStatus: LicenceStatus | null;
}

export function CheckoutUpgradeButton({ billingStatus }: Props) {
  const [loading, setLoading] = useState(false);

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
      const { data: plans, error: planErr } = await supabase
        .from("commercial_plans" as never)
        .select("id, plan_code, is_purchasable")
        .eq("is_purchasable" as never, true as never)
        .limit(1)
        .maybeSingle();

      if (planErr || !plans) {
        toast.error("No purchasable plan available. Please contact support.");
        return;
      }

      const plan = plans as { id: string; plan_code: string; is_purchasable: boolean };
      const { data, error } = await createCheckoutIntent(plan.id);

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

  return (
    <div className="space-y-2">
      <Button onClick={handleUpgrade} disabled={loading} className="w-full gap-2">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {loading ? "Preparing checkout…" : "Upgrade Plan"}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Secure payment via Flutterwave. Your licence activates automatically
        after server-side payment verification.
      </p>
    </div>
  );
}
