/**
 * useWorkspaceData — Workspace data fetching hook.
 *
 * Reads :companyId and :periodYear from the URL, fetches company + uploads,
 * finds the upload matching the period, and exposes WorkspaceState.
 *
 * Designed to be called once in WorkspaceLayout and shared via context.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { WorkspaceState, UploadSnapshot } from "@/lib/workspace/types";

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
}

export interface UseWorkspaceDataReturn {
  companyId: string;
  periodYear: number;
  company: WorkspaceCompany | null;
  upload: WorkspaceUpload | null;
  uploads: WorkspaceUpload[];
  workspaceState: WorkspaceState;
  loading: boolean;
  refreshUpload: () => void;
}

// ── deriveFiscalPeriod — same logic as Dashboard.tsx (shared utility) ─────────
function deriveFiscalPeriod(
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

// ── toUploadSnapshot — convert full upload to the snapshot deriveWorkspaceState needs ──
function toUploadSnapshot(
  upload: WorkspaceUpload,
  company: WorkspaceCompany | null,
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
    // These will be populated from DB sign-off queries in Phase 2
    hesabuPassedAt: null,
    kingaSignedAt: null,
    filingSubmittedAt: null,
  };
}

export function useWorkspaceData(): UseWorkspaceDataReturn {
  const { companyId, periodYear: periodYearParam } = useParams<{
    companyId: string;
    periodYear: string;
  }>();
  const { user } = useAuth();

  const cId = companyId ?? "";
  const pYear = parseInt(periodYearParam ?? "0", 10);

  const [company, setCompany] = useState<WorkspaceCompany | null>(null);
  const [uploads, setUploads] = useState<WorkspaceUpload[]>([]);
  const [upload, setUpload] = useState<WorkspaceUpload | null>(null);
  const [loading, setLoading] = useState(true);
  const companyRef = useRef<WorkspaceCompany | null>(null);

  const fetchData = useCallback(async () => {
    if (!user || !cId || !pYear) {
      setLoading(false);
      return;
    }

    setLoading(true);

    // Fetch company
    const { data: co } = await supabase
      .from("companies")
      .select("id, name, code, tin, reporting_framework, fiscal_year_end, currency")
      .eq("id", cId)
      .single();

    const coData = co as WorkspaceCompany | null;
    setCompany(coData);
    companyRef.current = coData;

    // Fetch uploads for this company, most recent first
    const { data: ups } = await supabase
      .from("trial_balance_uploads")
      .select("*")
      .eq("company_id", cId)
      .order("uploaded_at", { ascending: false })
      .limit(50);

    const uploadsData = (ups ?? []) as WorkspaceUpload[];
    setUploads(uploadsData);

    // Find upload matching pYear
    let match: WorkspaceUpload | null = null;

    // 1. Exact period_year column match (fastest)
    match = uploadsData.find((u) => u.period_year === pYear) ?? null;

    // 2. Fall back to deriveFiscalPeriod for old uploads
    if (!match) {
      match =
        uploadsData.find((u) => {
          const { periodYear } = deriveFiscalPeriod(u, coData);
          return periodYear === pYear;
        }) ?? null;
    }

    // 3. If still no match, use most recent upload
    if (!match && uploadsData.length > 0) {
      match = uploadsData[0];
    }

    setUpload(match);
    setLoading(false);
  }, [user, cId, pYear]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time subscription for upload changes
  useEffect(() => {
    if (!user || !cId) return;

    const channel = supabase
      .channel(`workspace-uploads-${cId}-${pYear}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "trial_balance_uploads" },
        (payload) => {
          const updated = payload.new as WorkspaceUpload;
          if (updated.company_id !== cId) return;
          setUploads((prev) =>
            prev.map((u) => (u.id === updated.id ? updated : u)),
          );
          setUpload((prev) =>
            prev?.id === updated.id ? updated : prev,
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, cId, pYear]);

  // Derive workspace state
  const snapshot: UploadSnapshot | null = upload
    ? toUploadSnapshot(upload, company)
    : null;

  const workspaceState = deriveWorkspaceState(cId, company?.name ?? "", pYear, snapshot);

  return {
    companyId: cId,
    periodYear: pYear,
    company,
    upload,
    uploads,
    workspaceState,
    loading,
    refreshUpload: fetchData,
  };
}
