import { useEffect, useState } from "react";
import { callCommercialRpc } from "@/lib/commercial/commercialRpc";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { generateCorrelationId, logWithContext } from "@/lib/observability/correlationId";

export interface BillingSummary {
  hasBillingCustomer: boolean;
  planCode: string | null;
  licenceStatus: LicenceStatus | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  entitlements: string[];
}

interface UseBillingSummaryResult {
  summary: BillingSummary | null;
  loading: boolean;
  error: string | null;
}

/**
 * Reads the caller's own commercial plan/licence state via the
 * server-authoritative get_my_billing_summary() RPC. Presentation only —
 * this hook never decides entitlement itself and must never be treated as
 * a gate; see src/lib/commercial/entitlementContract.ts.
 */
export function useBillingSummary(): UseBillingSummaryResult {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const correlationId = generateCorrelationId();

    async function load() {
      setLoading(true);
      setError(null);

      const { data, error: rpcError } = await callCommercialRpc("get_my_billing_summary");

      if (cancelled) return;

      if (rpcError) {
        logWithContext("error", "get_my_billing_summary RPC failed", { correlationId });
        setError(rpcError.message);
        setSummary(null);
        setLoading(false);
        return;
      }

      setSummary(
        data
          ? {
              hasBillingCustomer: data.has_billing_customer,
              planCode: data.plan_code,
              licenceStatus: data.licence_status,
              effectiveStart: data.effective_start,
              effectiveEnd: data.effective_end,
              entitlements: data.entitlements ?? [],
            }
          : null,
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { summary, loading, error };
}
