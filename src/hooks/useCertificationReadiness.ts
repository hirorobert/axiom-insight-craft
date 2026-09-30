/**
 * useCertificationReadiness — read-only fetch feeding computeCertificationReadiness.
 *
 * Sole write authority stays server-side (Iron Dome §4.2): this hook never
 * writes to tb_certifications or trial_balance_uploads, only reads.
 *
 * Two reads, in order:
 *   1. get_authoritative_certification(company_id, period_year) — returns
 *      whatever certification is authoritative for the COMPANY+PERIOD,
 *      which may belong to a different upload than the one being viewed
 *      (DEFECT-SLICE4B-UPLOAD-IDENTITY-UNVERIFIED-001). This hook does not
 *      resolve that — it hands both the row and its own upload_id to
 *      computeCertificationReadiness, which does the identity check.
 *   2. Fetched whenever (1) is empty OR belongs to a different upload than
 *      `uploadId`: the latest tb_certifications row for the CURRENT upload
 *      specifically, regardless of eligibility — diagnostic only, needed to
 *      tell "never certified" apart from "certified but blocked/needs
 *      review" and "certified but no longer current" for THIS upload, and
 *      (when authoritative belongs elsewhere) to still show per-layer
 *      detail for the displayed upload even though it isn't authoritative.
 *      Safe: tb_certifications' own "tbc_select" RLS policy already scopes
 *      to accepted firm members of the company (20260902130000), the same
 *      pattern just proven live for trial_balance_uploads in Slice 4B.
 *
 * `get_authoritative_certification`/`tb_certifications` predate the last
 * generated Supabase types snapshot (src/integrations/supabase/types.ts),
 * so calls here go through an untyped cast — the same established pattern
 * already used for post-generation RPCs elsewhere in this codebase.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TbCertificationRow } from "@/lib/workspace/computeCertificationReadiness";

interface UseCertificationReadinessResult {
  authoritative: TbCertificationRow | null;
  latestForUpload: TbCertificationRow | null;
  fetchFailed: boolean;
  loading: boolean;
  /**
   * uploadSubjectKey() of the upload the held rows were read for (null while nothing is held). trialBalanceVerdict
   * refuses rows whose subject differs from the upload on screen, so a late or stale result is never displayed.
   */
  subjectKey: string | null;
  /**
   * Re-runs both authoritative reads against the CURRENT companyId/
   * periodYear/uploadId (captured fresh on every render via a ref, so a
   * stale closure can never re-query an upload that has since changed).
   *
   * PPG-1 Finding 1 (pre-flight staleness): every mutation that can change
   * certification truth (AccountReviewPanel's decision+reprocess flow,
   * PrepareWorkspace's "process as audited accounts" reprocess) must call
   * this after its own authoritative commit completes — this hook's
   * effect alone only re-fires when companyId/periodYear/uploadId change,
   * which a same-upload reprocess never does.
   */
  refetch: () => void;
}

type CertClient = {
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

export interface CertificationReadinessReads {
  authoritative: TbCertificationRow | null;
  latestForUpload: TbCertificationRow | null;
}

/**
 * The two reads useCertificationReadiness performs, as a plain async function — no hook, so it can be called any
 * number of times in a loop (e.g. one summary per engagement on a multi-engagement hub) without violating the
 * rules of hooks. useCertificationReadiness below is a thin effect/state wrapper around this exact function; there
 * is only one implementation of the reads themselves.
 */
export async function fetchCertificationReadiness(
  companyId: string,
  periodYear: number,
  uploadId: string,
): Promise<CertificationReadinessReads> {
  const client = supabase as unknown as CertClient;

  const { data: authRows, error: authError } = await client.rpc("get_authoritative_certification", {
    p_company_id: companyId,
    p_period_year: periodYear,
  });
  if (authError) throw authError;

  const authoritative = (Array.isArray(authRows) ? authRows[0] : null) as TbCertificationRow | null;
  const authoritativeBelongsElsewhere = !!authoritative && authoritative.upload_id !== uploadId;

  let latestForUpload: TbCertificationRow | null = null;
  if (!authoritative || authoritativeBelongsElsewhere) {
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

  return { authoritative, latestForUpload };
}

export interface ReadinessState {
  /** The subject the latest request is for. */
  requested: string | null;
  /** The subject the held rows belong to (null while nothing is held). */
  subjectKey: string | null;
  authoritative: TbCertificationRow | null;
  latestForUpload: TbCertificationRow | null;
  fetchFailed: boolean;
  loading: boolean;
}
export type ReadinessEvent =
  | { type: "clear" }
  | { type: "request"; subject: string }
  | { type: "resolved"; subject: string; uploadId: string; reads: CertificationReadinessReads }
  | { type: "failed"; subject: string };
export const EMPTY_READINESS: ReadinessState = { requested: null, subjectKey: null, authoritative: null, latestForUpload: null, fetchFailed: false, loading: false };

/**
 * Deterministic state transitions for the readiness reads. A new subject clears the held rows at once (never shows the
 * previous upload's rows while loading); a result or failure for any subject other than the one currently requested is
 * dropped (a late result for a replaced upload); a per-upload row whose upload_id is not the requested upload is refused.
 */
export function readinessReducer(state: ReadinessState, event: ReadinessEvent): ReadinessState {
  switch (event.type) {
    case "clear":
      return EMPTY_READINESS;
    case "request":
      return event.subject === state.subjectKey
        ? { ...state, requested: event.subject, loading: true }
        : { ...EMPTY_READINESS, requested: event.subject, loading: true };
    case "resolved": {
      if (event.subject !== state.requested) return state;
      const latest = event.reads.latestForUpload && event.reads.latestForUpload.upload_id === event.uploadId ? event.reads.latestForUpload : null;
      return { requested: event.subject, subjectKey: event.subject, authoritative: event.reads.authoritative, latestForUpload: latest, fetchFailed: false, loading: false };
    }
    case "failed":
      if (event.subject !== state.requested) return state;
      return { ...EMPTY_READINESS, requested: event.subject, subjectKey: event.subject, fetchFailed: true };
  }
}

export function useCertificationReadiness(
  companyId: string | null | undefined,
  periodYear: number | null | undefined,
  uploadId: string | null | undefined,
  /** uploadSubjectKey(upload): a new version or source hash is a new subject (fresh read, previous rows cleared). */
  subjectKey?: string | null,
): UseCertificationReadinessResult {
  const [state, dispatch] = useReducer(readinessReducer, EMPTY_READINESS);

  // Refetch must always use the LATEST identity args, even if called from a
  // callback created on an earlier render (e.g. a reprocess poll's closure).
  const subject = subjectKey ?? uploadId ?? null;
  const argsRef = useRef({ companyId, periodYear, uploadId, subject });
  argsRef.current = { companyId, periodYear, uploadId, subject };

  const [refetchToken, setRefetchToken] = useState(0);
  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  useEffect(() => {
    const { companyId, periodYear, uploadId, subject } = argsRef.current;
    if (!companyId || !periodYear || !uploadId || !subject) {
      dispatch({ type: "clear" });
      return;
    }

    let cancelled = false;
    dispatch({ type: "request", subject });

    (async () => {
      try {
        const reads = await fetchCertificationReadiness(companyId, periodYear, uploadId);
        // The reducer also drops a result for any subject other than the one requested (belt and braces).
        if (!cancelled) dispatch({ type: "resolved", subject, uploadId, reads });
      } catch {
        if (!cancelled) dispatch({ type: "failed", subject });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, periodYear, uploadId, subject, refetchToken]);

  return {
    authoritative: state.authoritative,
    latestForUpload: state.latestForUpload,
    fetchFailed: state.fetchFailed,
    loading: state.loading,
    subjectKey: state.subjectKey,
    refetch,
  };
}
