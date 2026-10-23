import { PendingStatus } from "@/components/feedback/Activity";
/** Signed-in company directory. Normal sign-in never auto-selects a company or financial year.
 * Explicit validated service intent keeps its existing entitled routing; all readiness stays server-owned.
 * Discovery, billing and capacity gates are preserved; visiting the directory never creates a company or engagement.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { companyCreation } from "@/lib/workspace/accountNextAction";
import { AccountShell } from "@/components/account/AccountShell";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { addTrialBalanceReview, trialBalanceReviewPath, type AddReviewOutcome, type UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";
import { useReviewActionAccess } from "@/hooks/useReviewActionAccess";
import type { RpcClient } from "@/lib/workspace/workspaceSetupClient";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAccountHome } from "@/hooks/useAccountHome";
import { decideAccountHomeRoute } from "@/lib/workspace/accountHome";
import { decideReturningUserRoute, applyForceHub } from "@/lib/workspace/resolveReturningUserRoute";
import { engagementNextAction, firstUploadResultRoute } from "@/lib/workspace/engagementNextAction";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import EngagementHub from "@/pages/workspace/EngagementHub";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { parseAcceptInvitations } from "@/lib/commercial/paidActions";
import { clearServiceIntent, currentServiceIntent, intentFromUserMetadata, resolveServiceDestination } from "@/lib/commercial/serviceIntent";

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
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const selection = useRef(0);
  useEffect(() => () => { ++selection.current; }, []);
  const location = useLocation();
  // A normal sign-in always opens the company directory, even for a single company.
  // An explicit, validated service intent may retain its existing routing behaviour.
  const explicitHub = !!(location.state as { forceHub?: boolean } | null)?.forceHub;
  const forceHub = explicitHub || !currentServiceIntent(location.search, user?.user_metadata);
  // One bounded server read with exact counts (get_account_home): no routing decision is taken from a client list that
  // PostgREST could have truncated, and no company, engagement or upload list is fetched in full.
  const { loading: engagementsLoading, home, fetchFailed, refresh } = useAccountHome();
  const entries = home?.engagements.rows ?? [];
  const companiesWithoutEngagement = home?.companiesWithoutEngagement.rows ?? [];
  const sharedWorkspaces = home?.shared.rows ?? [];
  const unavailableEngagements = home?.withheld.rows ?? [];
  const homeTotals = home ? { entries: home.engagements.total, unavailable: home.withheld.total,
    companiesWithoutEngagement: home.companiesWithoutEngagement.total, shared: home.shared.total } : undefined;
  const { gates: reviewGates, refresh: refreshReviewGates } = useReviewActionAccess((unavailableEngagements ?? []).map((u) => u.companyId));
  const [routing, setRouting] = useState(false);
  const { summary: billing, loading: billingLoading, error: billingError, retry: retryBilling } = useBillingSummary();
  const { capacity, loading: capacityLoading, error: capacityError, retry: retryCapacity } = useMyEntityCapacity(!!user);

  // A service chosen on the public page (validated `service=` from the URL, or remembered by Auth in this tab). It is
  // navigational intent only: entitlement comes from the server's billing read; while that read is in flight we wait,
  // and if it fails the intent is ignored for this visit. Not entitled → /plans (intent preserved); entitled → the
  // service's workflow stage. A forced return to the hub (the workspace logo) never follows an intent.
  const serviceIntent = useMemo(() => (forceHub ? null : currentServiceIntent(location.search, user?.user_metadata)), [forceHub, location.search, user?.user_metadata]);
  const serviceDestination = resolveServiceDestination(serviceIntent, { loading: billingLoading, error: !!billingError, summary: billing });
  const stageSuffix = serviceDestination.kind === "workflow" ? `/${serviceDestination.stage}` : "";

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
        const closed = result.blocked.some((b) => b.code === "INVITATION_EXPIRED" || b.code === "INVITATION_CANCELLED");
        toast.info(closed ? "An invitation is no longer valid" : "An invitation is waiting for a seat", {
          description: closed
            ? "It expired or was cancelled. Ask the person who invited you to send a new invitation."
            : "The account that invited you has no free named-user seat for you yet. Your invitation is kept until it expires.",
        });
      }
    });
  }, [user?.id]);

  // The routing branch itself is a pure, synchronous decision (resolveReturningUserRoute.test.ts
  // covers it directly) — computed on every render, not stashed in state, so "chooser" and
  // "first_run" show up on first paint rather than waiting on an effect.
  const route =
    !authLoading && !engagementsLoading && !fetchFailed && serviceDestination.kind !== "wait"
      ? (home ? decideAccountHomeRoute(home, forceHub) : null)
      : null;

  // ── 3. Returning-user routing decision — only "resume" and "start_single_company" have a side
  // effect (navigate); "chooser" and "first_run" are rendered directly below. ─────────────────────
  useEffect(() => {
    if (!route) return;

    let cancelled = false;

    if (stageSuffix) {
      // Used once: clear this tab's copy and the account's own metadata copy (its profile, not financial data), so later
      // sign-ins resume normally. A failed clear is harmless — the intent only ever routes to a stage it is entitled to.
      clearServiceIntent();
      if (intentFromUserMetadata(user?.user_metadata)) void supabase.auth.updateUser({ data: { service_intent: null } });
    }
    if (route.kind === "resume") {
      navigate(`/workspace/${route.entry.companyId}/${route.entry.periodYear}${stageSuffix}`, { replace: true });
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
        navigate(`/workspace/${route.company.id}/${year}${stageSuffix}`, { replace: true });
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSuffix, route?.kind, route?.kind === "resume" ? route.entry.companyId : null, route?.kind === "start_single_company" ? route.company.id : null, route?.kind === "open_shared" ? route.workspace.id : null]);

  // An engagement's button names and opens its actual next step on the trial balance page (engagementNextAction),
  // for the same entity, period and current upload.
  const resumeEntry = (entry: { companyId: string; periodYear: number }) => {
    ++selection.current;
    navigate(`/workspace/${entry.companyId}/${entry.periodYear}?view=company`);
  };

  // Starting a service for a DIFFERENT company (or one with no open engagement) never touches an
  // existing engagement's data — it is a plain navigation into that company's own workspace, where
  // ServiceLaunchpad (rendered there because that workspace itself has no mandate yet) collects the
  // service selection.
  // A shared workspace opens straight into Prepare Data, the only stage its grant covers.
  const openShared = async (workspace: SharedWorkspace) => {
    const request = ++selection.current;
    const year = await resolveEntryPeriodYear(workspace);
    if (request === selection.current) navigate(`/workspace/${workspace.id}/${year}/prepare`);
  };

  // Explicit, user-selected: add Trial balance review to the EXISTING engagement (same period, no new engagement).
  const addReview = async (u: UnavailableServiceEngagement): Promise<AddReviewOutcome> => {
    const outcome = await addTrialBalanceReview(supabase as unknown as RpcClient, u.engagementId);
    if (outcome.ok) {
      // Re-read the hub from the authority, then continue into Trial balance review for the same entity and period.
      await refresh();
      navigate(trialBalanceReviewPath(u));
    } else {
      // A refusal may mean access or the plan changed since the gate was read: re-read it rather than keep a stale answer.
      refreshReviewGates();
    }
    return outcome;
  };

  const startService = async (company: WorkspaceCompany) => {
    const request = ++selection.current;
    const year = await resolveEntryPeriodYear(company);
    if (request === selection.current) navigate(`/workspace/${company.id}/${year}?view=company`);
  };

  // ── A chosen service the account is not entitled to: choose a plan first (the service is preserved) ──
  // Only a brand-new account is sent to /plans. An account with any history (open engagements,
  // companies, shared workspaces, or withheld engagements) keeps its normal routing — an expired or
  // plan-less user must always reach their existing workspaces and archive, never be trapped on /plans.
  if (!authLoading && user && serviceDestination.kind === "plans" && route?.kind === "first_run") {
    return <Navigate to={serviceDestination.href} replace />;
  }

  // ── Loading / redirect in flight ──────────────────────────────────────────
  if (serviceDestination.kind === "wait" || authLoading || engagementsLoading || (route?.kind === "first_run" && (billingLoading || capacityLoading)) || routing || route?.kind === "resume" || route?.kind === "start_single_company" || route?.kind === "open_shared") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <PendingStatus label="Opening your engagements…" className="w-full max-w-3xl px-6" skeleton />
      </div>
    );
  }

  const signOutHome = async () => { await signOut(); navigate("/auth", { replace: true }); };

  // ── The read itself failed — never conflated with "no companies"/"no engagements" ─────────────
  if (fetchFailed) {
    return (
      <AccountShell directory onSignOut={signOutHome}>
        <div className="flex flex-col items-center gap-4 text-center" data-testid="engagements-read-failed">
          <p role="alert" className="text-[13px] text-muted-foreground max-w-sm">
            Could not load your engagements. This is a connection problem, not a sign that anything is missing.
          </p>
          <Button onClick={() => refresh()} className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none">
            Try again
          </Button>
        </div>
      </AccountShell>
    );
  }

  // ── First run (no companies yet) and the ambiguous cases share ONE account home. Its next step is derived from the
  // authoritative plan and capacity reads (accountNextAction): choose a plan, or add the first company — never a dead
  // end and never a silent redirect. The server (create_entity) remains the authority for creating a company.
  const firstRun = route?.kind === "first_run";
  // ── Ambiguous: more than one open engagement, or more than one company with none open ──────────
  return (
    <EngagementHub
      entries={entries}
      companiesWithoutEngagement={companiesWithoutEngagement}
      sharedWorkspaces={sharedWorkspaces}
      onResume={resumeEntry}
      onStartService={startService}
      onOpenShared={openShared}
      unavailableEngagements={unavailableEngagements ?? []}
      onAddTrialBalanceReview={addReview}
      reviewGates={reviewGates}
      portfolio
      onSetPurpose={async (companyId, purpose, reason) => {
        // Recorded by the server (set_workspace_purpose: the company's owner only, with a reason; append-only).
        const { data, error } = await (supabase.rpc as unknown as (n: string, a: Record<string, unknown>) => PromiseLike<{ data: { outcome?: string } | null; error: unknown }>)(
          "set_workspace_purpose", { p_company_id: companyId, p_purpose: purpose, p_reason: reason });
        if (error) return "Not recorded: the purpose could not be saved. Try again.";
        if (data?.outcome === "recorded") { await refresh(); return "Recorded."; }
        return data?.outcome === "unchanged" ? "That purpose is already recorded." : data?.outcome === "forbidden" ? "Only the company's owner can record its purpose." : "Not recorded: a reason of at least 3 characters is required.";
      }}
      account={{
        identity: { name: user?.user_metadata?.display_name, email: user?.email },
        totals: homeTotals,
        openedAt: home ? Object.fromEntries(home.engagements.rows.map((r) => [r.engagementId, r.openedAt])) : undefined,
        billing,
        billingLoading,
        billingError: !!billingError,
        capacity,
        capacityLoading,
        capacityError: !!capacityError,
        onRetry: () => { retryBilling(); retryCapacity(); },
        onSignOut: signOutHome,
        onCompanyCreated: (companyId, year) => navigate(`/workspace/${companyId}/${year}`, { replace: true }),
        // A history entry of its own (not a replace): Back returns to the account home, which routes on from the
        // re-read engagements; the upload id in the URL keeps this exact result on refresh.
        onOpenTrialBalance: (companyId, year, uploadId) => navigate(firstUploadResultRoute(companyId, year, uploadId)),
        initialAddOpen: firstRun && companyCreation({
          billing: { loading: billingLoading, error: !!billingError, summary: billing },
          capacity: { loading: capacityLoading, error: !!capacityError, answer: capacity },
        }) === "allowed",
      }}
    />
  );
}
