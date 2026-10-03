/**
 * EngagementHub — the deterministic workspace chooser.
 *
 * Rendered by Dashboard.tsx exactly when the returning-user routing decision cannot resolve to a
 * single engagement on its own: either more than one engagement is open (never guess among them),
 * or none is open and there is more than one company to choose from. Every row's "state" comes
 * straight from deriveWorkspaceState via useActiveEngagements — this page invents no second
 * readiness computation.
 *
 * "Start another service" (a company with no open engagement) is a clearly separate action from
 * resuming an existing engagement — distinct section, distinct verb — so starting one can never be
 * mistaken for, or accidentally mutate, an engagement already in progress.
 *
 * It is also the ACCOUNT HOME the CFOClose logo leads to from inside a workspace. It adds no service, entity, plan or
 * entitlement logic: only existing navigation (Plans, Settings, Sign out), the existing company-creation flow in Settings
 * (CompanyManager → create_entity, capacity enforced by the server), the existing capacity notice and the existing
 * current-plan panel.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Building2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { customerCapabilityTitle } from "@/lib/workspace/mandate";
import { customerVisibleCapabilities, isStageCustomerVisible, TRIAL_BALANCE_REVIEW } from "@/lib/workspace/moduleAvailability";
import { NO_VISIBLE_NEXT_ACTION, trialBalanceReviewStep } from "@/lib/workspace/deriveOrientationSummary";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import { GATE_COPY, singleFlight, type AddReviewOutcome, type ReviewActionGate, type UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
import { EntityCapacityNotice } from "@/components/commercial/EntityCapacityNotice";

/** What the account home adds around the chooser. Absent (e.g. acceptance fixtures): the plain chooser. */
export interface AccountHome {
  billing: BillingSummary | null;
  billingLoading: boolean;
  billingError: boolean;
  capacity: CapacityAnswer | null;
  capacityLoading: boolean;
  capacityError: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}


export default function EngagementHub({
  entries,
  companiesWithoutEngagement,
  onResume,
  onStartService,
  sharedWorkspaces = [],
  onOpenShared,
  unavailableEngagements = [],
  onAddTrialBalanceReview,
  reviewGates = {},
  account,
}: {
  entries: ActiveEngagementEntry[];
  companiesWithoutEngagement: WorkspaceCompany[];
  onResume: (entry: ActiveEngagementEntry) => void;
  onStartService: (company: WorkspaceCompany) => void;
  /** Workspaces shared through an explicit Prepare grant (PR #32). They open into Prepare Data only. */
  sharedWorkspaces?: SharedWorkspace[];
  onOpenShared?: (workspace: SharedWorkspace) => void;
  /** Existing open engagements whose every service is currently withheld. Listed, never resumed. */
  unavailableEngagements?: UnavailableServiceEngagement[];
  onAddTrialBalanceReview?: (u: UnavailableServiceEngagement) => Promise<AddReviewOutcome>;
  /** Per company: may this person start Trial balance review there (existing authoritative access read)? Missing = checking. */
  reviewGates?: Record<string, ReviewActionGate>;
  account?: AccountHome;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Repeated clicks: one request at a time (singleFlight); a failure releases it so the user can retry.
  const addReview = useMemo(
    () =>
      singleFlight(async (u: UnavailableServiceEngagement) => {
        if (!onAddTrialBalanceReview) return;
        setPending(u.engagementId);
        setErrors((e) => { const n = { ...e }; delete n[u.engagementId]; return n; });
        try {
          const outcome = await onAddTrialBalanceReview(u);
          if (outcome.ok === false) setErrors((e) => ({ ...e, [u.engagementId]: outcome.message }));
        } catch {
          setErrors((e) => ({ ...e, [u.engagementId]: "Trial balance review could not be added. Try again." }));
        } finally {
          setPending(null);
        }
      }),
    [onAddTrialBalanceReview],
  );
  const hasCompanyAction = companiesWithoutEngagement.length > 0;
  const hasUnavailable = unavailableEngagements.length > 0;
  const emptyLine = hasUnavailable
    ? "Your existing service is currently unavailable. You can start Trial balance review for the same period below."
    : hasCompanyAction
      ? "No open engagements. Start a service for a company below."
      : sharedWorkspaces.length > 0
        ? "No open engagements of your own. Open a workspace shared with you below."
        : "No open engagements yet. Add a company below to begin.";
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border h-14 flex items-center justify-between gap-3 px-4 sm:px-6">
        <CFOCloseWordmark className="text-lg" />
        {account && (
          <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
            <Link to="/plans" className="px-2 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">Plans</Link>
            <Link to="/settings" className="px-2 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">Settings</Link>
            <Button variant="ghost" size="sm" onClick={account.onSignOut} className="h-8 rounded-none px-2 text-[13px]" data-testid="account-sign-out">
              <LogOut className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </Button>
          </nav>
        )}
      </header>

      <main className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
        {account && entries.length === 0 && (
          <section className="mb-10">
            <h1 className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-1">Your engagements</h1>
            <p className="text-[13px] text-muted-foreground" data-testid="hub-empty-line">{emptyLine}</p>
          </section>
        )}
        {entries.length > 0 && (
          <section className="mb-10">
            <h1 className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-1">
              Your engagements
            </h1>
            <p className="text-[13px] text-muted-foreground mb-6">
              {entries.length} open engagement{entries.length === 1 ? "" : "s"} — choose one to resume.
            </p>

            <ul className="grid gap-3" data-testid="engagement-hub-list">
              {entries.map((entry) => {
                const nextVisible = isStageCustomerVisible(entry.workspaceState.nextAction.mission);
                const stageLabel = nextVisible ? STAGE_CONFIGS[entry.workspaceState.nextAction.mission].label : TRIAL_BALANCE_REVIEW.title;
                const nextLabel = nextVisible
                  ? entry.workspaceState.nextAction.label
                  : trialBalanceReviewStep(entry.workspaceState, entry.safishaStatus)?.label ?? NO_VISIBLE_NEXT_ACTION;
                const services = customerVisibleCapabilities(entry.capabilities);
                const serviceLabel =
                  services.length > 0
                    ? services.map((c) => customerCapabilityTitle(c)).join(", ")
                    : "No service selected yet";

                return (
                  <li key={entry.engagementId}>
                    <SurfaceCard
                      className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4"
                      data-testid={`engagement-row-${entry.engagementId}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[15px] font-semibold text-foreground truncate">{entry.companyName}</span>
                          <span className="text-[12px] text-muted-foreground">· {entry.periodYear}</span>
                          {entry.framework && <span className="text-[12px] text-muted-foreground">· {entry.framework}</span>}
                        </div>
                        <p className="text-[12px] text-muted-foreground mt-0.5">{serviceLabel}</p>
                        <p className="text-[13px] text-foreground mt-2">
                          <span className="font-medium">{stageLabel}:</span> {nextLabel}
                        </p>
                      </div>
                      <Button
                        onClick={() => onResume(entry)}
                        data-testid={`resume-${entry.engagementId}`}
                        className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none shrink-0"
                      >
                        Resume <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                      </Button>
                    </SurfaceCard>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {hasUnavailable && (
          <section className="mb-10" data-testid="unavailable-engagements">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              Service currently unavailable
            </h2>
            <ul className="grid grid-cols-1 gap-3">
              {unavailableEngagements.map((u) => (
                <li key={u.engagementId}>
                  <SurfaceCard className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4" data-testid={`unavailable-row-${u.engagementId}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[15px] font-semibold text-foreground truncate">{u.companyName}</span>
                        <span className="text-[12px] text-muted-foreground">· {u.periodYear}</span>
                      </div>
                      <p className="text-[12px] text-muted-foreground mt-0.5">
                        Your existing service is currently unavailable. Your engagement and its records are kept.
                      </p>
                      {errors[u.engagementId] && (
                        <p role="alert" className="text-[12px] text-destructive mt-2" data-testid={`unavailable-error-${u.engagementId}`}>{errors[u.engagementId]}</p>
                      )}
                    </div>
                    {onAddTrialBalanceReview && (() => {
                      const gate: ReviewActionGate = reviewGates[u.companyId] ?? { state: "checking", reason: GATE_COPY.checking };
                      const blockedReason = gate.state === "allowed" ? null : gate.reason;
                      return (
                        <div className="flex flex-col items-start sm:items-end gap-1 shrink-0">
                          <Button
                            onClick={() => addReview(u)}
                            disabled={pending !== null || gate.state !== "allowed"}
                            aria-describedby={blockedReason ? `review-gate-${u.engagementId}` : undefined}
                            data-testid={`add-review-${u.engagementId}`}
                            data-gate={gate.state}
                            className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none"
                          >
                            {pending === u.engagementId ? "Starting…" : `Start ${TRIAL_BALANCE_REVIEW.title}`}
                            <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                          </Button>
                          {blockedReason && (
                            <p id={`review-gate-${u.engagementId}`} className="text-[12px] text-muted-foreground max-w-[18rem] sm:text-right" data-testid={`review-gate-${u.engagementId}`}>
                              {blockedReason}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </SurfaceCard>
                </li>
              ))}
            </ul>
          </section>
        )}

        {companiesWithoutEngagement.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              Start another service
            </h2>
            <ul className="grid gap-2" data-testid="companies-without-engagement-list">
              {companiesWithoutEngagement.map((company) => (
                <li key={company.id}>
                  <button
                    type="button"
                    onClick={() => onStartService(company)}
                    data-testid={`start-service-${company.id}`}
                    className="w-full text-left p-3.5 border border-border hover:border-primary/60 transition-colors flex items-center gap-3"
                  >
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-[13px] font-medium text-foreground flex-1 truncate">{company.name}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {sharedWorkspaces.length > 0 && onOpenShared && (
          <section className="mt-10">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              Shared with you
            </h2>
            {/* grid-cols-1 = minmax(0, 1fr): an implicit auto column grows to a long unbreakable workspace name and
                pushed this row off the screen at 320–375px. */}
            <ul className="grid grid-cols-1 gap-2" data-testid="shared-workspaces-list">
              {sharedWorkspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    onClick={() => onOpenShared(workspace)}
                    data-testid={`open-shared-${workspace.id}`}
                    className="w-full text-left p-3.5 border border-border hover:border-primary/60 transition-colors flex items-center gap-3"
                  >
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="min-w-0 text-[13px] font-medium text-foreground flex-1 truncate">{workspace.name}</span>
                    <span className="text-[12px] text-muted-foreground shrink-0">Prepare Data</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {account && (
          <section className="mt-10" data-testid="account-companies">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">Companies</h2>
            {/* The existing creation flow (Settings → Companies); capacity is enforced there by the server. */}
            <Link
              to="/settings"
              data-testid="manage-companies"
              className="w-full p-3.5 border border-border hover:border-primary/60 transition-colors flex items-center gap-3"
            >
              <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-[13px] font-medium text-foreground flex-1">Add or manage companies in Settings</span>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            </Link>
            <div className="mt-2">
              <EntityCapacityNotice capacity={account.capacity} loading={account.capacityLoading} error={account.capacityError} onRetry={account.onRetry} />
            </div>
          </section>
        )}
        {account && (
          <section className="mt-10" data-testid="account-plan">
            <CurrentPlanPanel billing={account.billing} capacity={account.capacity} loading={account.billingLoading} error={account.billingError} onRetry={account.onRetry} />
          </section>
        )}
      </main>
    </div>
  );
}
