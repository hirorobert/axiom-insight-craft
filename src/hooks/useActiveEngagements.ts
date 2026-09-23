/**
 * useActiveEngagements — the returning-user authority behind the product home / workspace hub.
 *
 * Reads every OPEN engagement across every company the signed-in member belongs to (RLS on
 * `engagements` already scopes this via get_member_company_ids() — see the "Members read
 * engagements" policy, migration 20260809083345 — so this is one cross-company read, not N
 * per-company queries) and, for each one, derives its WorkspaceState through the exact same
 * fetchWorkspaceSnapshot() pipeline a single workspace page uses. There is deliberately no
 * second, lighter-weight "summary" readiness computation here — Iron Dome's single-state-
 * authority rule (CLAUDE.md, and PR #31's PATH 6B) applies just as much to a list of engagements
 * as it does to one.
 *
 * "Service" is read from the SAME fold_engagement_mandate authority useEngagementMandate uses
 * (granted capabilities), not the coarser engagements.engagement_type column — capabilityTitle()
 * is the one place that vocabulary is already translated into practitioner language.
 *
 * Query safety:
 *   - bounded fan-out — per-engagement reads (fetchWorkspaceSnapshot + fold_engagement_mandate) run
 *     through mapWithConcurrencyLimit, never more than HUB_FAN_OUT_CONCURRENCY in flight at once,
 *     regardless of how many open engagements the firm has;
 *   - deterministic ordering — the engagements query orders by opened_at desc, id asc as an
 *     explicit tiebreak, and mapWithConcurrencyLimit preserves that order in its result array
 *     regardless of which engagement's read actually resolves first;
 *   - no cross-contamination — each engagement's read is its own independent promise with its own
 *     result slot; one engagement's failure can never bleed into or relabel another's data;
 *   - fail closed on ANY partial failure — if even one engagement's read fails, the WHOLE hub
 *     result is treated as failed (fetchFailed=true, entries=[]) rather than silently showing only
 *     the successful subset. Showing a partial picture as if it were complete is exactly how a
 *     genuinely-ambiguous "2 open engagements, 1 failed to load" could wrongly collapse into
 *     "1 engagement, auto-resume" — never acceptable per the single "never guess" invariant
 *     (resolveReturningUserRoute.ts).
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { fetchWorkspaceSnapshot } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { WorkspaceCompany, WorkspaceUpload } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { WorkspaceState } from "@/lib/workspace/types";
import type { EngagementCapability } from "@/lib/workspace/mandate";
import { mapWithConcurrencyLimit, aggregateSettledResults } from "@/lib/workspace/concurrencyLimit";
import { resolveActiveSession, endExpiredSession, handleIfAuthorizationFailure } from "@/lib/auth/sessionGuard";

const HUB_FAN_OUT_CONCURRENCY = 6;

export interface ActiveEngagementEntry {
  engagementId: string;
  companyId: string;
  companyName: string;
  periodYear: number;
  engagementType: string;
  /** companies.reporting_framework — persisted, never inferred. */
  framework: string | null;
  /** Granted capabilities, via fold_engagement_mandate — the same authority the workspace itself uses. */
  capabilities: EngagementCapability[];
  workspaceState: WorkspaceState;
  openedAt: string;
}

export interface UseActiveEngagementsReturn {
  loading: boolean;
  /** One open engagement, resolved with its full workspace state. */
  entries: ActiveEngagementEntry[];
  /** Active companies with NO open engagement — candidates for "start a service", never auto-resumed into. */
  companiesWithoutEngagement: WorkspaceCompany[];
  /** True only when the read itself failed — never conflated with "zero engagements". */
  fetchFailed: boolean;
  refresh: () => void;
}

function yearOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.getFullYear();
}

interface EngagementRow {
  id: string;
  fiscal_period_id: string;
  company_id: string;
  engagement_type: string;
  status: string;
  opened_at: string;
}

interface FiscalPeriodRow {
  id: string;
  reporting_end: string | null;
  fiscal_year_end: string | null;
}

export function useActiveEngagements(): UseActiveEngagementsReturn {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<ActiveEngagementEntry[]>([]);
  const [companiesWithoutEngagement, setCompaniesWithoutEngagement] = useState<WorkspaceCompany[]>([]);
  const [fetchFailed, setFetchFailed] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFetchFailed(false);

    // A signed-in-looking UI with an expired token would read every table as an anonymous
    // visitor and be refused. Fail closed to sign-in instead of showing an empty hub.
    if (!(await resolveActiveSession())) {
      setFetchFailed(true);
      setLoading(false);
      await endExpiredSession();
      return;
    }

    try {
      const { data: companiesData, error: companiesErr } = await supabase
        .from("companies")
        .select("id, name, code, tin, reporting_framework, fiscal_year_end, currency, created_at, filing_jurisdiction")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (companiesErr) throw companiesErr;
      const companies = (companiesData ?? []) as WorkspaceCompany[];
      const companyById = new Map(companies.map((c) => [c.id, c]));

      if (companies.length === 0) {
        setEntries([]);
        setCompaniesWithoutEngagement([]);
        setLoading(false);
        return;
      }

      const { data: engagementsData, error: engagementsErr } = await supabase
        .from("engagements")
        .select("id, fiscal_period_id, company_id, engagement_type, status, opened_at")
        .in("company_id", companies.map((c) => c.id))
        .eq("status", "open")
        // Explicit secondary tiebreak: opened_at ties (same instant) would otherwise leave the DB's
        // own row order to chance — id asc makes hub ordering fully deterministic across reloads.
        .order("opened_at", { ascending: false })
        .order("id", { ascending: true });
      if (engagementsErr) throw engagementsErr;
      const openEngagements = (engagementsData ?? []) as EngagementRow[];

      if (openEngagements.length === 0) {
        setEntries([]);
        setCompaniesWithoutEngagement(companies);
        setLoading(false);
        return;
      }

      const periodIds = Array.from(new Set(openEngagements.map((e) => e.fiscal_period_id)));
      const { data: periodsData, error: periodsErr } = await supabase
        .from("fiscal_periods")
        .select("id, reporting_end, fiscal_year_end")
        .in("id", periodIds);
      if (periodsErr) throw periodsErr;
      const periodById = new Map(((periodsData ?? []) as FiscalPeriodRow[]).map((p) => [p.id, p]));

      // Bulk-fetch uploads for every company that has an open engagement, once — each engagement's
      // fetchWorkspaceSnapshot call reuses its own company's slice instead of re-querying.
      const engagementCompanyIds = Array.from(new Set(openEngagements.map((e) => e.company_id)));
      const { data: uploadsData, error: uploadsErr } = await supabase
        .from("trial_balance_uploads")
        .select("*")
        .in("company_id", engagementCompanyIds)
        .order("uploaded_at", { ascending: false });
      if (uploadsErr) throw uploadsErr;
      const uploadsByCompany = new Map<string, WorkspaceUpload[]>();
      for (const u of (uploadsData ?? []) as WorkspaceUpload[]) {
        const list = uploadsByCompany.get(u.company_id ?? "") ?? [];
        list.push(u);
        uploadsByCompany.set(u.company_id ?? "", list);
      }

      const settled = await mapWithConcurrencyLimit(
        openEngagements,
        HUB_FAN_OUT_CONCURRENCY,
        async (eng): Promise<ActiveEngagementEntry | null> => {
          const period = periodById.get(eng.fiscal_period_id);
          const periodYear = yearOf(period?.reporting_end) ?? yearOf(period?.fiscal_year_end);
          if (!periodYear) return null; // Never guess a period year — skip rather than fabricate.

          const company = companyById.get(eng.company_id) ?? null;

          const [snapshot, foldRes] = await Promise.all([
            fetchWorkspaceSnapshot({
              companyId: eng.company_id,
              periodYear,
              companyOverride: company,
              uploadsOverride: uploadsByCompany.get(eng.company_id) ?? [],
            }),
            supabase.rpc("fold_engagement_mandate", { p_engagement_id: eng.id }),
          ]);

          const fold = (foldRes.data ?? []) as { capability: string; granted: boolean }[];
          const capabilities = fold.filter((r) => r.granted).map((r) => r.capability as EngagementCapability);

          return {
            engagementId: eng.id,
            companyId: eng.company_id,
            companyName: company?.name ?? snapshot.company?.name ?? "",
            periodYear,
            engagementType: eng.engagement_type,
            framework: company?.reporting_framework ?? null,
            capabilities,
            workspaceState: snapshot.workspaceState,
            openedAt: eng.opened_at,
          };
        },
      );

      // Fail closed on ANY partial failure — see the module doc comment's "Query safety" section.
      // A silently-dropped failed engagement could make a genuinely ambiguous set of engagements
      // look unambiguous, which the returning-user routing decision must never be allowed to see.
      const aggregated = aggregateSettledResults(settled);
      if (aggregated.failed) throw new Error("one or more engagements failed to resolve");
      setEntries(aggregated.values);

      const companyIdsWithEngagement = new Set(openEngagements.map((e) => e.company_id));
      setCompaniesWithoutEngagement(companies.filter((c) => !companyIdsWithEngagement.has(c.id)));
    } catch {
      setFetchFailed(true);
      setEntries([]);
      setCompaniesWithoutEngagement([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return { loading, entries, companiesWithoutEngagement, fetchFailed, refresh: load };
}
