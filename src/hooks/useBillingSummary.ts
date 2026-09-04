import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";

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

    async function load() {
      setLoading(true);
      setError(null);

      // `get_my_billing_summary` is defined in migration
      // 20260904180000_commercial_foundation_wave_omega1.sql, not yet applied
      // to any project this environment can reach — generated Supabase types
      // predate it and cannot be regenerated without live DB access. Cast is
      // scoped to the function name only.
      const { data, error: rpcError } = await supabase.rpc("get_my_billing_summary" as never);

      if (cancelled) return;

      if (rpcError) {
        setError(rpcError.message);
        setSummary(null);
        setLoading(false);
        return;
      }

      const raw = data as {
        has_billing_customer: boolean;
        plan_code: string | null;
        licence_status: LicenceStatus | null;
        effective_start: string | null;
        effective_end: string | null;
        entitlements: string[];
      } | null;

      setSummary(
        raw
          ? {
              hasBillingCustomer: raw.has_billing_customer,
              planCode: raw.plan_code,
              licenceStatus: raw.licence_status,
              effectiveStart: raw.effective_start,
              effectiveEnd: raw.effective_end,
              entitlements: raw.entitlements ?? [],
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
