/**
 * Dashboard — Authenticated routing gateway / product home.
 *
 * Returning-user routing (never guesses) — the branch decision itself is the PURE function
 * decideReturningUserRoute (resolveReturningUserRoute.ts), computed synchronously from
 * useActiveEngagements' result on every render:
 *   exactly 1 open engagement                        → auto-resume its authoritative overview
 *                                                        (regardless of how many OTHER companies
 *                                                        have no open engagement — one unambiguous
 *                                                        active engagement is resumed directly;
 *                                                        those companies stay reachable from
 *                                                        "Start another service" inside the workspace)
 *   >1 open engagements                               → EngagementHub, a deterministic chooser
 *   0 open engagements, exactly 1 company             → auto-navigate in (ServiceLaunchpad shows there)
 *   0 open engagements, >1 companies                  → EngagementHub, "start another service" list
 *   0 companies                                        → FirstRunEngagement
 *
 * "Open engagement" is read via useActiveEngagements, which is the SAME authority
 * (fetchWorkspaceSnapshot → deriveWorkspaceState) every workspace page itself uses — this page
 * invents no second readiness computation, only a routing decision on top of it.
 *
 * Zero accounting panels. Zero upload management. Zero financial logic.
 * Those live in their respective workspace stage pages.
 */

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useActiveEngagements, type ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import { decideReturningUserRoute, applyForceHub } from "@/lib/workspace/resolveReturningUserRoute";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import FirstRunEngagement from "@/components/workspace/FirstRunEngagement";
import EngagementHub from "@/pages/workspace/EngagementHub";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { parseAcceptInvitations } from "@/lib/commercial/paidActions";

/**
 * Return the most recently completed fiscal year for a company.
 * Guards against implausible years (e.g. "2001" from bad date pickers).
 * Accepts years within a ±5 year window of today; falls back to current year − 1.
 */
function resolvePeriodYear(fiscalYearEnd: string | null, uploadPeriodYear?: number | null): number {
  const currentYear = new Date().getFullYear();
  const MIN_YEAR = currentYear - 10;
  const MAX_YEAR = currentYear + 1;

  // Prefer the upload's own period_year when it's a plausible value
  if (uploadPeriodYear && uploadPeriodYear >= MIN_YEAR && uploadPeriodYear <= MAX_YEAR) {
    return uploadPeriodYear;
  }
  // Fall back to fiscal_year_end date
  if (fiscalYearEnd) {
    const year = new Date(fiscalYearEnd).getFullYear();
    if (year >= MIN_YEAR && year <= MAX_YEAR) return year;
  }
  return currentYear - 1;
}

/** A company with no open engagement has no fiscal_period to derive a year from — resolve the same way the pre-hub Dashboard always did. */
async function resolveEntryPeriodYear(company: Pick<WorkspaceCompany, "id" | "fiscal_year_end">): Promise<number> {
  const { data: recentUp } = await supabase
    .from("trial_balance_uploads")
    .select("period_year")
    .eq("company_id", company.id)
    .in("status", ["complete", "valid"])
    .order("uploaded_at", { ascending: false })
    .limit(1);

  const uploadYear = (recentUp?.[0] as { period_year?: number | null } | undefined)?.period_year ?? null;
  return resolvePeriodYear(company.fiscal_year_end, uploadYear);
}

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Set only by the authenticated header's logo (WorkspaceLayout.tsx) — an explicit "take me to the
  // hub" escape, distinct from a bare sign-in landing at /dashboard. See applyForceHub's own doc
  // comment for exactly what this does and does not change.
  const forceHub = !!(location.state as { forceHub?: boolean } | null)?.forceHub;
  const { loading: engagementsLoading, entries, companiesWithoutEngagement, sharedWorkspaces, fetchFailed, refresh } = useActiveEngagements();
  const [routing, setRouting] = useState(false);

  // ── 1. Auth guard ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  // ── 2. Auto-accept workspace invitations ──────────────────────────────────
  // When an invited user signs in, their pending invitations are accepted one by one by the server
  // (accept_workspace_invitations). The inviting account must have a named-user seat for each: an invitation it
  // has no seat for stays pending (never deleted) and the person is told why, by structured code.
  useEffect(() => {
    if (!user) return;
    supabase.rpc("accept_workspace_invitations" as never).then(({ data, error }) => {
      if (error) {
        console.warn("accept_workspace_invitations:", error.code);
        return;
      }
      const result = parseAcceptInvitations(data);
      if (result && result.blocked.length > 0) {
        toast.info("An invitation is waiting for a seat", {
          description: "The account that invited you has no free named-user seat yet. Your invitation is kept and will work once a seat is available.",
        });
      }
    });
  }, [user?.id]);

  // The routing branch itself is a pure, synchronous decision (resolveReturningUserRoute.test.ts
  // covers it directly) — computed on every render, not stashed in state, so "chooser" and
  // "first_run" show up on first paint rather than waiting on an effect.
  const route =
    !authLoading && !engagementsLoading && !fetchFailed
      ? applyForceHub(decideReturningUserRoute(entries, companiesWithoutEngagement, sharedWorkspaces), forceHub)
      : null;

  // ── 3. Returning-user routing decision — only "resume" and "start_single_company" have a side
  // effect (navigate); "chooser" and "first_run" are rendered directly below. ─────────────────────
  useEffect(() => {
    if (!route) return;

    let cancelled = false;

    if (route.kind === "resume") {
      navigate(`/workspace/${route.entry.companyId}/${route.entry.periodYear}`, { replace: true });
    } else if (route.kind === "open_shared") {
      setRouting(true);
      resolveEntryPeriodYear(route.workspace).then((year) => {
        if (cancelled) return;
        navigate(`/workspace/${route.workspace.id}/${year}/prepare`, { replace: true });
      });
    } else if (route.kind === "start_single_company") {
      setRouting(true);
      resolveEntryPeriodYear(route.company).then((year) => {
        if (cancelled) return;
        navigate(`/workspace/${route.company.id}/${year}`, { replace: true });
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.kind, route?.kind === "resume" ? route.entry.companyId : null, route?.kind === "start_single_company" ? route.company.id : null, route?.kind === "open_shared" ? route.workspace.id : null]);

  const resumeEntry = (entry: ActiveEngagementEntry) => {
    navigate(`/workspace/${entry.companyId}/${entry.periodYear}`);
  };

  // Starting a service for a DIFFERENT company (or one with no open engagement) never touches an
  // existing engagement's data — it is a plain navigation into that company's own workspace, where
  // ServiceLaunchpad (rendered there because that workspace itself has no mandate yet) collects the
  // service selection.
  // A shared workspace opens straight into Prepare Data, the only stage its grant covers.
  const openShared = async (workspace: SharedWorkspace) => {
    const year = await resolveEntryPeriodYear(workspace);
    navigate(`/workspace/${workspace.id}/${year}/prepare`);
  };

  const startService = async (company: WorkspaceCompany) => {
    const year = await resolveEntryPeriodYear(company);
    navigate(`/workspace/${company.id}/${year}`);
  };

  // ── Loading / redirect in flight ──────────────────────────────────────────
  if (authLoading || engagementsLoading || routing || route?.kind === "resume" || route?.kind === "start_single_company" || route?.kind === "open_shared") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  // ── The read itself failed — never conflated with "no companies"/"no engagements" ─────────────
  if (fetchFailed) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-5 text-center">
        <CFOCloseWordmark className="text-lg" />
        <p className="text-[13px] text-muted-foreground max-w-sm">
          Could not load your engagements. This is a connection problem, not a sign that anything is missing.
        </p>
        <Button onClick={() => refresh()} className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none">
          Try again
        </Button>
      </div>
    );
  }

  // ── First run: no companies yet ────────────────────────────────────────────
  if (route?.kind === "first_run") {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border h-14 flex items-center px-6">
          <CFOCloseWordmark className="text-lg" />
        </header>

        <main className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-5 py-10">
          {/* One inline form. On success we route straight into the workspace —
              no nested dialogs, no "reload the page" dead end. */}
          <FirstRunEngagement
            onCreated={(companyId, year) =>
              navigate(`/workspace/${companyId}/${year}`, { replace: true })
            }
          />
        </main>
      </div>
    );
  }

  // ── Ambiguous: more than one open engagement, or more than one company with none open ──────────
  return (
    <EngagementHub
      entries={entries}
      companiesWithoutEngagement={companiesWithoutEngagement}
      sharedWorkspaces={sharedWorkspaces}
      onResume={resumeEntry}
      onStartService={startService}
      onOpenShared={openShared}
    />
  );
}
