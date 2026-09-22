/**
 * fetchWorkspaceSnapshot — the one-shot, plain-async read pipeline behind a single workspace's
 * WorkspaceState: company → uploads → active upload → sign-off reads → certification readiness →
 * deriveWorkspaceState(). Extracted from useWorkspaceData.ts so the SAME pipeline can be called
 * any number of times in a loop (one per open engagement, for the returning-user hub) without
 * violating the rules of hooks — a hook can only be called from component/hook bodies, never
 * from inside Promise.all/map. There is only one implementation of this pipeline; useWorkspaceData
 * is a thin subscription/refresh wrapper around it, not a second copy.
 *
 * Deliberately does NOT include the live realtime subscription — that is inherently per-mounted-
 * component state, owned by useWorkspaceData. A hub summary is a point-in-time read.
 */

import { supabase } from "@/integrations/supabase/client";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { resolveActiveUpload } from "./resolveActiveUpload";
import { computeCertificationReadiness } from "./computeCertificationReadiness";
import { fetchCertificationReadiness } from "@/hooks/useCertificationReadiness";
import type { WorkspaceState, UploadSnapshot } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonCompatible = any;

export interface WorkspaceUpload {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  company_id: string | null;
  company_name: string | null;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  is_valid: boolean | null;
  validation_report: JsonCompatible;
  accounting_errors: JsonCompatible;
  processing_result: JsonCompatible;
  fiscal_year_end?: string | null;
  period_year?: number | null;
  safisha_status?: string | null;
}

export interface WorkspaceCompany {
  id: string;
  name: string;
  code: string | null;
  tin: string | null;
  reporting_framework: string | null;
  fiscal_year_end: string | null;
  currency: string | null;
  created_at?: string | null;
  /** Explicitly selected filing jurisdiction (ISO alpha-2), or null. Never inferred. */
  filing_jurisdiction?: string | null;
}

export interface WorkspaceSnapshot {
  company: WorkspaceCompany | null;
  uploads: WorkspaceUpload[];
  upload: WorkspaceUpload | null;
  hesabuPassedAt: string | null;
  kingaSignedAt: string | null;
  filingSubmittedAt: string | null;
  workspaceState: WorkspaceState;
}

/** Same logic previously duplicated in Dashboard.tsx — kept here as the single copy. */
export function deriveFiscalPeriod(
  upload: WorkspaceUpload,
  company: WorkspaceCompany | null,
): { periodYear: number; periodEndMonth: number } {
  if (upload.period_year && upload.period_year > 2000) {
    const fyeStr = upload.fiscal_year_end ?? company?.fiscal_year_end;
    const month = fyeStr ? new Date(fyeStr).getMonth() + 1 : 12;
    return { periodYear: upload.period_year, periodEndMonth: isNaN(month) ? 12 : month };
  }
  if (upload.fiscal_year_end) {
    const d = new Date(upload.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  if (company?.fiscal_year_end) {
    const d = new Date(company.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  const uploadDate = new Date(upload.uploaded_at);
  const uploadMonth = uploadDate.getMonth() + 1;
  const uploadYear = uploadDate.getFullYear();
  return {
    periodYear: uploadMonth <= 9 ? uploadYear - 1 : uploadYear,
    periodEndMonth: 12,
  };
}

function toUploadSnapshot(
  upload: WorkspaceUpload,
  company: WorkspaceCompany | null,
  hesabuPassedAt: string | null,
  kingaSignedAt: string | null,
  filingSubmittedAt: string | null,
  certificationVerdict: UploadSnapshot["certificationVerdict"],
  certificationBlocker: string | null,
): UploadSnapshot {
  const { periodYear } = deriveFiscalPeriod(upload, company);
  return {
    id: upload.id,
    companyId: upload.company_id ?? "",
    companyName: upload.company_name ?? "",
    periodYear,
    status: upload.status,
    isValid: upload.is_valid,
    safishaStatus: upload.safisha_status ?? null,
    uploadedAt: upload.uploaded_at,
    processedAt: upload.processed_at,
    hasMapping: !!upload.processing_result?.mapping,
    hesabuPassedAt,
    kingaSignedAt,
    filingSubmittedAt,
    certificationVerdict,
    certificationBlocker,
  };
}

export interface FetchWorkspaceSnapshotArgs {
  companyId: string;
  periodYear: number;
  requestedUploadId?: string | null;
  /** Pass already-fetched company/uploads rows to avoid a redundant query (the hub bulk-fetches these once per company). */
  companyOverride?: WorkspaceCompany | null;
  uploadsOverride?: WorkspaceUpload[];
}

export async function fetchWorkspaceSnapshot(args: FetchWorkspaceSnapshotArgs): Promise<WorkspaceSnapshot> {
  const { companyId, periodYear, requestedUploadId = null } = args;

  const company =
    args.companyOverride !== undefined
      ? args.companyOverride
      : ((
          await supabase
            .from("companies")
            .select("id, name, code, tin, reporting_framework, fiscal_year_end, currency, created_at, filing_jurisdiction")
            .eq("id", companyId)
            .single()
        ).data as WorkspaceCompany | null);

  const uploads =
    args.uploadsOverride ??
    (((
      await supabase
        .from("trial_balance_uploads")
        .select("*")
        .eq("company_id", companyId)
        .order("uploaded_at", { ascending: false })
        .limit(50)
    ).data ?? []) as WorkspaceUpload[]);

  const match: WorkspaceUpload | null = resolveActiveUpload<WorkspaceUpload>({
    uploads,
    requestedUploadId,
    periodYear,
    derivePeriodYear: (u) => deriveFiscalPeriod(u, company).periodYear,
  });

  const [hesabuRes, kingaRes, filingRes] = await Promise.all([
    match
      ? supabase
          .from("hesabu_validations")
          .select("validated_at")
          .eq("upload_id", match.id)
          .eq("gate_satisfied", true)
          .order("validated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("statement_sign_offs")
      .select("approver_signed_at")
      .eq("company_id", companyId)
      .eq("period_year", periodYear)
      .not("approver_signed_at", "is", null)
      .maybeSingle(),
    supabase
      .from("filing_obligations")
      .select("updated_at")
      .eq("company_id", companyId)
      .eq("period_year", periodYear)
      .eq("status", "filed")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const hesabuPassedAt = (hesabuRes.data as { validated_at: string } | null)?.validated_at ?? null;
  const kingaSignedAt = (kingaRes.data as { approver_signed_at: string } | null)?.approver_signed_at ?? null;
  const filingSubmittedAt = (filingRes.data as { updated_at: string } | null)?.updated_at ?? null;

  let certificationVerdict: UploadSnapshot["certificationVerdict"];
  let certificationBlocker: string | null = null;
  if (match) {
    try {
      const reads = await fetchCertificationReadiness(companyId, periodYear, match.id);
      const readiness = computeCertificationReadiness({
        uploadExists: true,
        currentUploadId: match.id,
        authoritative: reads.authoritative,
        latestForUpload: reads.latestForUpload,
        fetchFailed: false,
        revalidating: false,
      });
      certificationVerdict = readiness.verdict;
      certificationBlocker = readiness.blocker;
    } catch {
      const readiness = computeCertificationReadiness({
        uploadExists: true,
        currentUploadId: match.id,
        authoritative: null,
        latestForUpload: null,
        fetchFailed: true,
        revalidating: false,
      });
      certificationVerdict = readiness.verdict;
      certificationBlocker = readiness.blocker;
    }
  }

  const snapshot: UploadSnapshot | null = match
    ? toUploadSnapshot(match, company, hesabuPassedAt, kingaSignedAt, filingSubmittedAt, certificationVerdict, certificationBlocker)
    : null;

  const workspaceState = deriveWorkspaceState(companyId, company?.name ?? "", periodYear, snapshot);

  return { company, uploads, upload: match, hesabuPassedAt, kingaSignedAt, filingSubmittedAt, workspaceState };
}
