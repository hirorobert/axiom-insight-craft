import { useBusyState } from "@/hooks/useBusyState";
/**
 * EngagementHub — the deterministic workspace chooser, and the ACCOUNT HOME.
 *
 * Rendered by Dashboard.tsx when the returning-user routing decision cannot resolve to a single engagement on its own
 * (more than one engagement open, or none open with more than one company), for a first run (no company yet), and when
 * the CFOClose logo leads back from inside a workspace. Every row's "state" comes straight from deriveWorkspaceState
 * via useActiveEngagements — this page invents no second readiness computation.
 *
 * Account home (with `account`): inside the one signed-in frame (AccountShell), it shows ONE primary next action
 * derived by deriveAccountNextAction from the authoritative plan, capacity, company, period and review-permission
 * reads. Every other control on the page is secondary (outline or a link), and an action that cannot be taken is never
 * shown as a disabled button: the page states the prerequisite and the way to meet it instead.
 *
 * Company creation is offered here when the server's capacity answer permits it, through the existing creation form
 * (FirstRunEngagement → create_entity); the server remains the authority and refuses anything the answer did not
 * foresee.
 *
 * "Start another service" (a company with no open engagement) is a clearly separate action from resuming an existing
 * engagement — distinct section, distinct verb — so starting one can never be mistaken for, or accidentally mutate, an
 * engagement already in progress.
 */

import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Building2, Plus, Upload, MoreHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { AccountShell } from "@/components/account/AccountShell";
import FirstRunEngagement from "@/components/workspace/FirstRunEngagement";
import FirstUpload from "@/components/workspace/FirstUpload";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { customerCapabilityTitle } from "@/lib/workspace/mandate";
import { customerVisibleCapabilities, isStageCustomerVisible, TRIAL_BALANCE_REVIEW } from "@/lib/workspace/moduleAvailability";
import { NO_VISIBLE_NEXT_ACTION, trialBalanceReviewStep } from "@/lib/workspace/deriveOrientationSummary";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
/** An engagement as the home knows it: the bounded read gives identity only; the legacy list also carried its state. */
type HubEntry = Pick<ActiveEngagementEntry, "engagementId" | "companyId" | "companyName" | "periodYear"> & Partial<Omit<ActiveEngagementEntry, "engagementId" | "companyId" | "companyName" | "periodYear">>;
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import { GATE_COPY, createFlightHolder, type AddReviewOutcome, type ReviewActionGate, type UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";
import { companyCreation, deriveAccountNextAction, type AccountNextAction } from "@/lib/workspace/accountNextAction";
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
import { groupEngagements, periodDates, PURPOSE_EXPLANATION, PURPOSE_WORDS, type CompanyGroup, type WorkspacePurpose } from "@/lib/workspace/engagementGroups";
import { EntityCapacityNotice } from "@/components/commercial/EntityCapacityNotice";
import { engagementNextAction } from "@/lib/workspace/engagementNextAction";
import { EngagementPortfolio } from "@/components/workspace/EngagementPortfolio";

/** What the account home adds around the chooser. Absent (e.g. acceptance fixtures): the plain chooser. */
export interface AccountHome {
  /** Exact totals when the lists are bounded samples (get_account_home); count-based decisions use these. */
  identity?: { name?: string | null; email?: string | null };
  totals?: { entries: number; unavailable: number; companiesWithoutEngagement: number; shared: number };
  billing: BillingSummary | null;
  billingLoading: boolean;
  billingError: boolean;
  capacity: CapacityAnswer | null;
  capacityLoading: boolean;
  capacityError: boolean;
  onRetry: () => void;
  onSignOut: () => void;
  /** A company was created through the existing form (create_entity). Absent: no creation form is offered. */
  onCompanyCreated?: (companyId: string, periodYear: number) => void;
  /** Open the creation form on arrival (a first run with room for a company). */
  initialAddOpen?: boolean;
  /**
   * Phase 2 P2-3: opens a trial balance's result (the Prepare page). When present, a first run with room for a company
   * starts with the upload itself (FirstUpload) instead of the company form; the form stays available as a secondary.
   */
  onOpenTrialBalance?: (companyId: string, periodYear: number, uploadId: string) => void;
}

const PRIMARY = "h-10 px-5 text-[13px] font-semibold rounded-none shadow-none";
const SECONDARY = "h-10 px-5 text-[13px] font-medium rounded-none shadow-none";

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
  onSetPurpose,
  portfolio = false,
}: {
  entries: HubEntry[];
  companiesWithoutEngagement: WorkspaceCompany[];
  onResume: (entry: HubEntry) => void;
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
  /** Records a company's purpose (set_workspace_purpose: owner only); resolves to the outcome in words. Absent: no control. */
  onSetPurpose?: (companyId: string, purpose: WorkspacePurpose, reason: string) => Promise<string>;
  /** The engagements are listed by the server, page by page (EngagementPortfolio), instead of from `entries`. */
  portfolio?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Decided before the first render so the creation form never opens beside the first upload (one primary action).
  const firstUploadOffered = !!account?.onOpenTrialBalance && !!account?.initialAddOpen;
  const [addOpen, setAddOpen] = useState(!!account?.initialAddOpen && !firstUploadOffered);
  const navigate = useNavigate();
  const addFormId = useId();
  // Repeated clicks: one request at a time; a failure releases the guard so the user can retry. The guard lives in ONE
  // holder for the life of this component (createFlightHolder): the parent passes a new callback on every render, and
  // only the callback is swapped — rebuilding the guard would reset it mid-request.
  const flight = useRef<ReturnType<typeof createFlightHolder<[UnavailableServiceEngagement], void>> | null>(null);
  if (!flight.current) flight.current = createFlightHolder<[UnavailableServiceEngagement], void>(async () => undefined);
  flight.current.current = async (u: UnavailableServiceEngagement) => {
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
  };
  const addReview = flight.current.run;

  const reads = account && {
    billing: { loading: account.billingLoading, error: account.billingError, summary: account.billing },
    capacity: { loading: account.capacityLoading, error: account.capacityError, answer: account.capacity },
  };
  const next: AccountNextAction | null = reads
    ? deriveAccountNextAction({
        ...reads,
        entries: entries.map((e) => ({ engagementId: e.engagementId, companyName: e.companyName, periodYear: e.periodYear })),
        totals: account?.totals ? { entries: account.totals.entries, unavailable: account.totals.unavailable, companiesWithoutEngagement: account.totals.companiesWithoutEngagement } : undefined,
        unavailable: onAddTrialBalanceReview ? unavailableEngagements : [],
        reviewGates,
        companiesWithoutEngagement,
        sharedCount: onOpenShared ? (account?.totals?.shared ?? sharedWorkspaces.length) : 0,
      })
    : null;
  const creation = reads ? companyCreation(reads) : null;
  const canCreate = creation === "allowed" && !!account?.onCompanyCreated;
  // Phase 2 P2-3/P2-4: the upload is offered from the home. Entities the user can see (the server re-checks authority).
  const uploadEntities = [...new Map([
    ...entries.map((e) => [e.companyId, { id: e.companyId, name: e.companyName }] as const),
    ...companiesWithoutEngagement.map((c) => [c.id, { id: c.id, name: c.name }] as const),
  ]).values()];
  const uploadHome: "full" | "full_needs_plan" | "compact" | null = !account?.onOpenTrialBalance || !next ? null
    : next.kind === "add_company" && canCreate ? "full"
    : next.kind === "choose_plan" && uploadEntities.length === 0 && sharedWorkspaces.length === 0 ? "full_needs_plan"
    : uploadEntities.length > 0 && !["checking", "retry"].includes(next.kind) ? "compact"
    : null;

  const renderEntry = (entry: HubEntry) => {
    if (!entry.workspaceState) return null;
    const nextVisible = isStageCustomerVisible(entry.workspaceState.nextAction.mission);
    const stageLabel = nextVisible ? STAGE_CONFIGS[entry.workspaceState.nextAction.mission].label : TRIAL_BALANCE_REVIEW.title;
    const nextLabel = nextVisible
      ? entry.workspaceState.nextAction.label
      : trialBalanceReviewStep(entry.workspaceState)?.label ?? NO_VISIBLE_NEXT_ACTION;
    const action = engagementNextAction(entry.workspaceState);
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
              <span className="text-[14px] font-semibold text-foreground">FY{entry.periodYear}</span>
              {entry.framework && <span className="text-[12px] text-muted-foreground">· {entry.framework}</span>}
            </div>
            <p className="text-[12px] text-muted-foreground mt-0.5" data-testid={`engagement-period-${entry.engagementId}`}>
              {periodDates(entry.periodStart, entry.periodEnd) ?? "Period dates not recorded"} · {serviceLabel}
            </p>
            <p className="text-[13px] text-foreground mt-2">
              <span className="font-medium">{stageLabel}:</span> {nextLabel}
            </p>
          </div>
          <Button
            variant={account ? "outline" : "default"}
            onClick={() => onResume(entry)}
            data-testid={`resume-${entry.engagementId}`}
            data-action={action.kind}
            aria-label={`${action.label}: ${entry.companyName} FY${entry.periodYear}`}
            className={`${account ? SECONDARY : PRIMARY} shrink-0`}
          >
            {action.label} <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />
          </Button>
        </SurfaceCard>
      </li>
    );
  };

  /** The row's own control. Never a disabled button: allowed → the action; otherwise the reason in words. */
  const reviewControl = (u: UnavailableServiceEngagement) => {
    if (!onAddTrialBalanceReview) return null;
    const gate: ReviewActionGate = reviewGates[u.companyId] ?? { state: "checking", reason: GATE_COPY.checking };
    if (gate.state === "allowed") {
      return (
        <Button
          variant={account ? "outline" : "default"}
          onClick={() => addReview(u)}
          disabled={pending !== null}
          aria-busy={pending === u.engagementId}
          data-testid={`add-review-${u.engagementId}`}
          data-gate={gate.state}
          className={`${account ? SECONDARY : PRIMARY} shrink-0`}
        >
          {pending === u.engagementId ? "Starting…" : `Start ${TRIAL_BALANCE_REVIEW.title}`}
          <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />
        </Button>
      );
    }
    // The account's own missing plan is explained once, in the next step above; the row only says it waits for it.
    const reason = gate.reason === GATE_COPY.noPlan && next?.kind === "choose_plan" ? "Starts once a plan is active." : gate.reason;
    return (
      <p role={gate.state === "checking" ? "status" : undefined} className="text-[12px] text-muted-foreground max-w-[18rem] sm:text-right shrink-0"
        data-testid={`review-gate-${u.engagementId}`} data-gate={gate.state}>
        {reason}
      </p>
    );
  };

  const hasUnavailable = unavailableEngagements.length > 0;
  const body = (
    <>
      {account && portfolio && <header className="mb-5" data-testid="portfolio-home-header">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Companies &amp; engagements</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose an engagement or add a company.</p>
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-t-sm border border-border bg-card px-3 py-3" data-testid="portfolio-toolbar">
          {canCreate && <Button asChild className="h-9 gap-2 rounded-sm text-[13px]" data-testid="add-company"><Link to="/companies/new"><Plus className="h-4 w-4" aria-hidden="true" />Add company</Link></Button>}
          {account.onOpenTrialBalance && <Link to="/upload" className="inline-flex h-9 items-center gap-2 rounded-sm border border-border px-3 text-[13px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="portfolio-upload-link"><Upload className="h-4 w-4" aria-hidden="true" />Upload trial balance</Link>}
        </div>
        {account.onOpenTrialBalance && <p className="mt-2 text-xs text-muted-foreground">For a new upload, confirm the company and reporting period before starting the checks.</p>}
      </header>}
      {account && next && (!portfolio || ["checking", "retry", "choose_plan", "capacity_reached", "ask_owner", "start_review"].includes(next.kind)) && (
        <section className="mb-6" aria-label="Account next step">
          {!portfolio && <h2 id="account-home-title" className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-4">Your engagements</h2>}
          {/* With the engagements list, uploading lives on its own page (/upload), linked from the list. */}
          {uploadHome === "compact" && account.onOpenTrialBalance && !portfolio && (
            <div className="mb-4">
              <FirstUpload compact entities={uploadEntities} canCreateEntity={creation === "allowed"} needsPlan={next.kind === "choose_plan"}
                onChoosePlan={() => navigate("/plans")} onOpenResult={account.onOpenTrialBalance} />
            </div>
          )}
          {(uploadHome === "full" || uploadHome === "full_needs_plan") && account.onOpenTrialBalance && !portfolio ? (
            <FirstUpload needsPlan={uploadHome === "full_needs_plan"} onChoosePlan={() => navigate("/plans")} onOpenResult={account.onOpenTrialBalance} />
          ) : (
          <NextActionCard
            next={next}
            resumeLabel={(() => { const e = next.kind === "resume" ? entries.find((x) => x.engagementId === next.engagementId) : undefined; return e?.workspaceState ? engagementNextAction(e.workspaceState).label : e ? "Open engagement" : null; })()}
            busy={pending !== null}
            onRetry={account.onRetry}
            onResume={() => { const e = entries.find((x) => next.kind === "resume" && x.engagementId === next.engagementId); if (e) onResume(e); }}
            onStartReview={() => { const u = unavailableEngagements.find((x) => next.kind === "start_review" && x.engagementId === next.engagementId); if (u) addReview(u); }}
            onStartService={() => { const c = companiesWithoutEngagement.find((x) => next.kind === "start_service" && x.id === next.companyId); if (c) onStartService(c); }}
            onOpenShared={sharedWorkspaces.length === 1 && onOpenShared ? () => onOpenShared(sharedWorkspaces[0]) : undefined}
            onAddCompany={canCreate ? () => portfolio ? navigate("/companies/new") : setAddOpen(true) : undefined}
            addFormId={addFormId}
            pendingLabel={next.kind === "start_review" && pending === next.engagementId ? "Starting…" : null}
          />
          )}
        </section>
      )}
      {portfolio && account && (
        <div className="mb-10"><EngagementPortfolio headingLevel="h2" title="All engagements" compactHeader renderEntityOptions={onSetPurpose ? (r) => <CompanyOptions companyId={r.companyId} companyName={r.companyName} current={r.purpose === "not_stated" ? null : r.purpose as WorkspacePurpose} onSet={onSetPurpose} /> : undefined} /></div>
      )}
      {!(portfolio && account) && entries.length > 0 && (
        <section className="mb-10">
          {account ? (
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              {entries.length} open engagement{entries.length === 1 ? "" : "s"}
            </h2>
          ) : (
            <>
              <h1 className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-1">Your engagements</h1>
              <p className="text-[13px] text-muted-foreground mb-6">
                {entries.length} open engagement{entries.length === 1 ? "" : "s"} — choose one to resume.
              </p>
            </>
          )}

          {/* Grouped by company, each period with its dates and service; test and training workspaces (explicit, recorded
              purpose — never inferred from a name) are listed apart from client work. */}
          {(() => {
            const { client, test } = groupEngagements(entries as ActiveEngagementEntry[]);
            const renderGroup = (g: CompanyGroup<ActiveEngagementEntry>) => (
              <li key={g.companyId} data-testid={`company-group-${g.companyId}`}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="text-[15px] font-semibold text-foreground">{g.companyName}</h3>
                  {g.distinguisher ? <span className="text-[12px] text-muted-foreground">({g.distinguisher})</span> : null}
                  <span className="text-[12px] text-muted-foreground" data-testid={`company-purpose-${g.companyId}`}>· {g.purpose ? PURPOSE_WORDS[g.purpose] : "Purpose not stated"}</span>
                </div>
                {onSetPurpose ? <CompanyOptions companyId={g.companyId} companyName={g.companyName} current={g.purpose} onSet={onSetPurpose} /> : null}
                <ul className="grid gap-2">{g.periods.map(renderEntry)}</ul>
              </li>
            );
            return (
              <>
                <ul className="grid gap-6" data-testid="engagement-hub-list">{client.map(renderGroup)}</ul>
                {test.length > 0 ? (
                  <details className="mt-8" data-testid="test-workspaces">
                    <summary className="cursor-pointer text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Test and training workspaces ({test.reduce((n, g) => n + g.periods.length, 0)})
                    </summary>
                    <ul className="mt-3 grid gap-6">{test.map(renderGroup)}</ul>
                  </details>
                ) : null}
              </>
            );
          })()}
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
                  {reviewControl(u)}
                </SurfaceCard>
              </li>
            ))}
          </ul>
        </section>
      )}

      {companiesWithoutEngagement.length > 0 && (
        <section className="mb-10">
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
                  className="w-full text-left p-3.5 border border-border hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring transition-colors flex items-center gap-3"
                >
                  <Building2 className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="text-[13px] font-medium text-foreground flex-1 truncate">{company.name}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {account?.totals && account.totals.companiesWithoutEngagement > companiesWithoutEngagement.length && (
            <p className="mt-2 text-[12px] text-muted-foreground" data-testid="companiesWithoutEngagement-more">And {account.totals.companiesWithoutEngagement - companiesWithoutEngagement.length} more — open them from Settings › Companies.</p>
          )}
        </section>
      )}
      {sharedWorkspaces.length > 0 && onOpenShared && (
        <section className="mb-10">
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
                  className="w-full text-left p-3.5 border border-border hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring transition-colors flex items-center gap-3"
                >
                  <Building2 className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="min-w-0 text-[13px] font-medium text-foreground flex-1 truncate">{workspace.name}</span>
                  <span className="text-[12px] text-muted-foreground shrink-0">Prepare Data</span>
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {account?.totals && account.totals.shared > sharedWorkspaces.length && (
            <p className="mt-2 text-[12px] text-muted-foreground" data-testid="shared-more">And {account.totals.shared - sharedWorkspaces.length} more — each is also listed under Engagements.</p>
          )}
        </section>
      )}
      {account && !portfolio && (
        <section className="mb-10" data-testid="account-companies" aria-labelledby="account-companies-title">
          <h2 id="account-companies-title" className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">Companies</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {canCreate && !addOpen && (
              <Button variant="outline" onClick={() => setAddOpen(true)} aria-expanded={false} aria-controls={addFormId} data-testid="add-company" className={SECONDARY}>
                Add a company
              </Button>
            )}
            {/* Company settings live in Settings (the account header), not in the middle of the home. */}
          </div>
          {canCreate && addOpen && account.onCompanyCreated && (
            <div id={addFormId} className="mt-4" data-testid="add-company-form">
              <FirstRunEngagement headingLevel="h2" onCreated={account.onCompanyCreated} />
              <Button variant="link" className="mt-2 px-0 text-[13px]" onClick={() => setAddOpen(false)} data-testid="add-company-cancel">Cancel</Button>
            </div>
          )}
          {/* The plan's capacity, said once: the next step already explains a missing plan or a full capacity. */}
          {creation !== "allowed" && creation !== "needs_plan" && next?.kind !== "capacity_reached" && (
            <div className="mt-2">
              <EntityCapacityNotice capacity={account.capacity} loading={account.capacityLoading} error={account.capacityError} onRetry={account.onRetry} />
            </div>
          )}
          {creation === "needs_plan" && next?.kind !== "choose_plan" && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="company-creation-needs-plan">Adding a company needs an active plan.</p>
          )}
        </section>
      )}
      {/* A plan read in flight or failed is already the next step (checking / try again): never said twice. */}
      {account && !portfolio && !account.billingLoading && !account.billingError && (
        <section className="mt-10" data-testid="account-plan">
          <CurrentPlanPanel billing={account.billing} capacity={account.capacity} loading={account.billingLoading} error={account.billingError} onRetry={account.onRetry}
            hidePlansAction={next?.kind === "choose_plan" || next?.kind === "capacity_reached"} />
        </section>
      )}
    </>
  );

  if (account) return <AccountShell identity={account.identity} onSignOut={account.onSignOut}>{body}</AccountShell>;
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border h-14 flex items-center justify-between gap-3 px-4 sm:px-6">
        <CFOCloseWordmark className="text-lg" />
      </header>
      <main className="max-w-3xl mx-auto px-5 py-10 sm:py-14">{body}</main>
    </div>
  );
}

/** The one primary action of the account home. At most one filled button; anything else is a link. */
function NextActionCard({ next, resumeLabel, busy, onRetry, onResume, onStartReview, onStartService, onOpenShared, onAddCompany, addFormId, pendingLabel }: {
  next: AccountNextAction;
  /** The resumed engagement's actual next step (engagementNextAction), e.g. "Review account classifications". */
  resumeLabel: string | null;
  busy: boolean;
  onRetry: () => void;
  onResume: () => void;
  onStartReview: () => void;
  onStartService: () => void;
  onOpenShared?: () => void;
  onAddCompany?: () => void;
  addFormId: string;
  pendingLabel: string | null;
}) {
  const arrow = <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />;
  let primary: ReactNode = null;
  switch (next.kind) {
    case "retry": primary = <Button onClick={onRetry} className={PRIMARY} data-testid="next-action-primary">Try again</Button>; break;
    case "choose_plan":
    case "capacity_reached":
      // ONE action: the plans page (it states every plan and its price). Never a second link to the same place.
      primary = <Button asChild className={PRIMARY} data-testid="next-action-primary"><Link to="/plans">{next.kind === "choose_plan" ? "Choose a plan" : "See larger plans"}{arrow}</Link></Button>;
      break;
    case "resume": primary = <Button onClick={onResume} className={PRIMARY} data-testid="next-action-primary">{resumeLabel ?? "Continue"}{arrow}</Button>; break;
    case "start_review": primary = <Button pending={busy} onClick={onStartReview} disabled={busy} aria-busy={!!pendingLabel} className={PRIMARY} data-testid="next-action-primary">{pendingLabel ?? `Start ${TRIAL_BALANCE_REVIEW.title}`}{arrow}</Button>; break;
    case "start_service": primary = <Button onClick={onStartService} className={PRIMARY} data-testid="next-action-primary">Start{arrow}</Button>; break;
    case "open_shared": primary = onOpenShared ? <Button onClick={onOpenShared} className={PRIMARY} data-testid="next-action-primary">Open{arrow}</Button> : null; break;
    case "add_company": primary = onAddCompany ? <Button onClick={onAddCompany} aria-controls={addFormId} className={PRIMARY} data-testid="next-action-primary">Add a company{arrow}</Button> : null; break;
    default: break;
  }
  return (
    <div className="border border-border bg-card p-5 sm:p-6" data-testid="account-next-action" data-kind={next.kind} role={next.kind === "checking" ? "status" : undefined}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Next step</p>
      <h2 className="mt-1 text-lg font-semibold text-foreground">{next.title}</h2>
      {"detail" in next && <p className="mt-1 text-[13px] text-muted-foreground">{next.detail}</p>}
      {primary && <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">{primary}</div>}
    </div>
  );
}

/**
 * Company options: a per-company disclosure under the company's name. It holds the workspace purpose (owner only,
 * recorded by set_workspace_purpose with a reason; the server refuses anyone else), with what the purpose means.
 */
function CompanyOptions({ companyId, companyName, current, onSet }: { companyId: string; companyName: string; current: WorkspacePurpose | null;
  onSet: (companyId: string, purpose: WorkspacePurpose, reason: string) => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<WorkspacePurpose>(current === "test" ? "client" : "test");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const ids = { panel: useId(), heading: useId(), purpose: useId(), reason: useId(), help: useId() };
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogTrigger asChild><Button variant="ghost" size="icon" aria-label={`Company options: ${companyName}`} data-testid={`company-options-${companyId}`}><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></Button></DialogTrigger>
        <DialogContent className="sm:max-w-xl" data-testid={`company-options-panel-${companyId}`}>
          <DialogHeader><DialogTitle>Workspace purpose · {companyName}</DialogTitle><DialogDescription>Record how this workspace is used.</DialogDescription></DialogHeader>
          <p className="mt-1 text-[13px] text-foreground">Recorded: {current ? PURPOSE_WORDS[current] : "Not stated"}</p>
          <p id={ids.help} className="mt-1 max-w-prose text-[12px] text-muted-foreground" data-testid={`purpose-explanation-${companyId}`}>{PURPOSE_EXPLANATION}</p>
          <form className="mt-3 grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end" aria-describedby={ids.help} data-testid={`set-purpose-${companyId}`}
            onSubmit={async (e) => { e.preventDefault(); if (busy || reason.trim().length < 3) return; if (!setBusy(true)) return; try { setNotice(await onSet(companyId, purpose, reason.trim())); } catch { setNotice("Purpose could not be recorded. Try again."); } finally { setBusy(false); } }}>
            <div>
              <label htmlFor={ids.purpose} className="block text-[12px] font-medium text-foreground">Purpose</label>
              <select id={ids.purpose} className="mt-1 h-9 w-full border border-input bg-background px-2 text-[13px]" value={purpose} onChange={(e) => setPurpose(e.target.value as WorkspacePurpose)}>
                {(Object.keys(PURPOSE_WORDS) as WorkspacePurpose[]).map((p) => <option key={p} value={p}>{PURPOSE_WORDS[p]}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <label htmlFor={ids.reason} className="block text-[12px] font-medium text-foreground">Reason (at least 3 characters)</label>
              <input id={ids.reason} className="mt-1 h-9 w-full border border-input bg-background px-2 text-[13px]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <Button pending={busy} type="submit" variant="outline" className="h-9 rounded-none px-4 text-[13px] shadow-none" disabled={busy || reason.trim().length < 3}>{busy ? "Recording…" : "Record purpose"}</Button>
              <button type="button" className="text-[13px] underline underline-offset-4" onClick={() => setOpen(false)}>Close</button>
            </div>
          </form>
          {notice ? <p role="status" className="mt-2 text-[12px] text-muted-foreground">{notice}</p> : null}
        </DialogContent>
    </Dialog>
  );
}
