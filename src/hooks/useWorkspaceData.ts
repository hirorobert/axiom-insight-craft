/**
 * useWorkspaceData — Workspace data fetching hook.
 *
 * Reads :companyId and :periodYear from the URL, fetches company + uploads,
 * finds the upload matching the period, and exposes WorkspaceState.
 *
 * Designed to be called once in WorkspaceLayout and shared via context.
 *
 * The actual read pipeline (company → uploads → active upload → sign-offs →
 * certification → deriveWorkspaceState) lives in fetchWorkspaceSnapshot.ts so
 * the returning-user hub (useActiveEngagements.ts) can run the exact same
 * pipeline per engagement without a second, competing implementation. This
 * hook adds the two things that are inherently single-workspace/stateful:
 * the realtime subscription and the loading/refreshing lifecycle.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { fetchWorkspaceSnapshot } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { WorkspaceCompany, WorkspaceUpload } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { WorkspaceState } from "@/lib/workspace/types";
import { fetchWorkspaceAccess, type WorkspaceAccess, type WorkspaceAccessState } from "@/lib/workspace/workspaceAccess";

export type { WorkspaceCompany, WorkspaceUpload };

export interface UseWorkspaceDataReturn {
  companyId: string;
  periodYear: number;
  company: WorkspaceCompany | null;
  upload: WorkspaceUpload | null;
  uploads: WorkspaceUpload[];
  workspaceState: WorkspaceState;
  loading: boolean;
  /** True while a background re-read is in flight. Never blanks the UI. */
  refreshing: boolean;
  refreshUpload: () => void;
  /** Server-decided access (get_workspace_access): owner, member, capability (Prepare only), denied or error. */
  accessState: WorkspaceAccessState;
  /** Shorthand for accessState.access when granted, else null. */
  access: WorkspaceAccess | null;
}

const EMPTY_STATE: WorkspaceState = {
  companyId: "",
  periodYear: 0,
  companyName: "",
  missions: {
    prepare: { status: "not_started", label: "Prepare Data", summary: "", href: "" },
    reconcile: { status: "not_applicable", label: "Reconcile", summary: "", href: "" },
    statements: { status: "locked", label: "Prepare Statements", summary: "", href: "" },
    tax: { status: "locked", label: "Compute Tax", summary: "", href: "" },
    compliance: { status: "not_applicable", label: "Compliance Review", summary: "", href: "" },
    filing: { status: "locked", label: "Prepare Outputs", summary: "", href: "" },
    monitor: { status: "not_applicable", label: "Monitor", summary: "", href: "" },
  },
  nextAction: {
    id: "loading",
    label: "Loading…",
    description: "",
    href: "",
    blocked: true,
    mission: "prepare",
    priority: 0,
  },
};

export function useWorkspaceData(): UseWorkspaceDataReturn {
  const { companyId, periodYear: periodYearParam } = useParams<{
    companyId: string;
    periodYear: string;
  }>();
  const [searchParams] = useSearchParams();
  const requestedUploadId = searchParams.get("upload");
  const { user } = useAuth();

  const cId = companyId ?? "";
  const pYear = parseInt(periodYearParam ?? "0", 10);

  const [company, setCompany] = useState<WorkspaceCompany | null>(null);
  const [uploads, setUploads] = useState<WorkspaceUpload[]>([]);
  const [upload, setUpload] = useState<WorkspaceUpload | null>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(EMPTY_STATE);
  // `loading` is the FIRST-PAINT gate only. Background polls set `refreshing`
  // so the screen never flashes back to skeletons (one book, one truth).
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [accessState, setAccessState] = useState<WorkspaceAccessState>({ status: "loading" });
  const hasLoadedRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!user || !cId || !pYear) {
      setLoading(false);
      return;
    }

    if (hasLoadedRef.current) setRefreshing(true);
    else setLoading(true);

    // Access first: a workspace the caller may not open is never read at all (fail closed, no partial render).
    const nextAccess = await fetchWorkspaceAccess(cId).catch((): WorkspaceAccessState => ({ status: "error" }));
    // A background re-read that fails transiently keeps the last known grant; a definitive answer always wins,
    // so a revocation takes effect on the next read.
    setAccessState((prev) => (nextAccess.status === "error" && prev.status === "granted" && hasLoadedRef.current ? prev : nextAccess));
    if (nextAccess.status !== "granted") {
      if (nextAccess.status === "denied") { setCompany(null); setUploads([]); setUpload(null); setWorkspaceState(EMPTY_STATE); }
      hasLoadedRef.current = true;
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const snapshot = await fetchWorkspaceSnapshot({ companyId: cId, periodYear: pYear, requestedUploadId });

    // Keep the last known company on a transient read failure — never blank the masthead mid-session. The
    // companies row is owner-only; anyone else gets the resolver's minimum metadata (never the TIN or code).
    const meta = nextAccess.access.company;
    const resolvedCompany: WorkspaceCompany | null = snapshot.company ?? {
      id: meta.id, name: meta.name, code: null, tin: null, reporting_framework: meta.reporting_framework,
      fiscal_year_end: meta.fiscal_year_end, currency: meta.currency, created_at: meta.created_at, filing_jurisdiction: null,
    };
    if (resolvedCompany) setCompany(resolvedCompany);
    setUploads(snapshot.uploads);
    setUpload(snapshot.upload);
    setWorkspaceState(snapshot.workspaceState);

    hasLoadedRef.current = true;
    setLoading(false);
    setRefreshing(false);
  }, [user, cId, pYear, requestedUploadId]);

  // A different company/period is a genuinely new book — gate first paint again.
  useEffect(() => {
    hasLoadedRef.current = false;
    setAccessState({ status: "loading" });
  }, [cId, pYear]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Keep a live handle on the current fetch so the realtime subscription can re-derive
  // workspaceState without re-subscribing every time fetchData's identity changes.
  const fetchDataRef = useRef(fetchData);
  useEffect(() => {
    fetchDataRef.current = fetchData;
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

          // workspaceState is DERIVED state held in React state — the pushed row alone does not
          // update it. Without this re-read, stage locks, mission statuses and nextAction stay
          // frozen at the pre-push values while the same screen already shows the fresh upload
          // (a live self-contradiction, and later stages stay locked until a manual reload).
          // Re-derive through the ONE pipeline (fetchWorkspaceSnapshot) — it also re-reads the
          // sign-off and certification authorities the pushed row cannot carry. Unconditional:
          // payload.old is not reliably populated, so "did anything material change" cannot be
          // decided here; a background re-read sets `refreshing`, never blanks the screen.
          void fetchDataRef.current();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, cId, pYear]);

  const refreshUpload = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    companyId: cId,
    periodYear: pYear,
    company,
    upload,
    uploads,
    workspaceState,
    loading,
    refreshing,
    refreshUpload,
    accessState,
    access: accessState.status === "granted" ? accessState.access : null,
  };
}
