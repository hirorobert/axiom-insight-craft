/**
 * useCertificationReadiness — read-only fetch feeding computeCertificationReadiness.
 *
 * Sole write authority stays server-side (Iron Dome §4.2): this hook never
 * writes to tb_certifications or trial_balance_uploads, only reads.
 *
 * Two reads, in order:
 *   1. get_authoritative_certification(company_id, period_year) — returns a
 *      row only when the latest certification for the current upload is
 *      both eligible and current.
 *   2. If (1) is empty: the latest tb_certifications row for the CURRENT
 *      upload specifically, regardless of eligibility — needed to tell
 *      "never certified" (pending) apart from "certified but blocked/
 *      needs review" and "certified but now stale" (drifted source hash).
 *      Safe: tb_certifications' own "tbc_select" RLS policy already scopes
 *      to accepted firm members of the company (20260902130000), the same
 *      pattern just proven live for trial_balance_uploads in Slice 4B.
 *
 * `get_authoritative_certification`/`tb_certifications` predate the last
 * generated Supabase types snapshot (src/integrations/supabase/types.ts),
 * so calls here go through an untyped cast — the same established pattern
 * already used for post-generation RPCs elsewhere in this codebase.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TbCertificationRow } from "@/lib/workspace/computeCertificationReadiness";

interface UseCertificationReadinessResult {
  authoritative: TbCertificationRow | null;
  latestForUpload: TbCertificationRow | null;
  fetchFailed: boolean;
  loading: boolean;
}

export function useCertificationReadiness(
  companyId: string | null | undefined,
  periodYear: number | null | undefined,
  uploadId: string | null | undefined,
): UseCertificationReadinessResult {
  const [state, setState] = useState<UseCertificationReadinessResult>({
    authoritative: null,
    latestForUpload: null,
    fetchFailed: false,
    loading: false,
  });

  useEffect(() => {
    if (!companyId || !periodYear || !uploadId) {
      setState({ authoritative: null, latestForUpload: null, fetchFailed: false, loading: false });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));

    (async () => {
      try {
        const client = supabase as unknown as {
          rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
          from: (table: string) => {
            select: (cols: string) => {
              eq: (col: string, val: unknown) => {
                eq: (col: string, val: unknown) => {
                  order: (col: string, opts: { ascending: boolean }) => {
                    limit: (n: number) => Promise<{ data: unknown; error: unknown }>;
                  };
                };
              };
            };
          };
        };

        const { data: authRows, error: authError } = await client.rpc("get_authoritative_certification", {
          p_company_id: companyId,
          p_period_year: periodYear,
        });
        if (authError) throw authError;

        const authoritative = (Array.isArray(authRows) ? authRows[0] : null) as TbCertificationRow | null;

        let latestForUpload: TbCertificationRow | null = null;
        if (!authoritative) {
          const { data: latestRows, error: latestError } = await client
            .from("tb_certifications")
            .select("*")
            .eq("company_id", companyId)
            .eq("upload_id", uploadId)
            .order("sequence_no", { ascending: false })
            .limit(1);
          if (latestError) throw latestError;
          latestForUpload = (Array.isArray(latestRows) ? latestRows[0] : null) as TbCertificationRow | null;
        }

        if (!cancelled) {
          setState({ authoritative, latestForUpload, fetchFailed: false, loading: false });
        }
      } catch {
        if (!cancelled) {
          setState({ authoritative: null, latestForUpload: null, fetchFailed: true, loading: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, periodYear, uploadId]);

  return state;
}
