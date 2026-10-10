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
import { Link } from "react-router-dom";
import { ArrowRight, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { AccountShell } from "@/components/account/AccountShell";
import FirstRunEngagement from "@/components/workspace/FirstRunEngagement";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { customerCapabilityTitle } from "@/lib/workspace/mandate";
import { customerVisibleCapabilities, isStageCustomerVisible, TRIAL_BALANCE_REVIEW } from "@/lib/workspace/moduleAvailability";
import { NO_VISIBLE_NEXT_ACTION, trialBalanceReviewStep } from "@/lib/workspace/deriveOrientationSummary";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import { GATE_COPY, createFlightHolder, type AddReviewOutcome, type ReviewActionGate, type UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";
import { companyCreation, deriveAccountNextAction, type AccountNextAction } from "@/lib/workspace/accountNextAction";
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";
import { activationRequestHref, REQUEST_ACTIVATION_LABEL } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
import { groupEngagements, periodDates, PURPOSE_WORDS, type CompanyGroup, type WorkspacePurpose } from "@/lib/workspace/engagementGroups";
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
  /** A company was created through the existing form (create_entity). Absent: no creation form is offered. */
  onCompanyCreated?: (companyId: string, periodYear: number) => void;
  /** Open the creation form on arrival (a first run with room for a company). */
  initialAddOpen?: boolean;
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
  /** Records a company's purpose (set_workspace_purpose: owner only); resolves to the outcome in words. Absent: no control. */
  onSetPurpose?: (companyId: string, purpose: WorkspacePurpose, reason: string) => Promise<string>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(!!account?.initialAddOpen);
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
        unavailable: onAddTrialBalanceReview ? unavailableEngagements : [],
        reviewGates,
        companiesWithoutEngagement,
        sharedCount: onOpenShared ? sharedWorkspaces.length : 0,
      })
    : null;
  const creation = reads ? companyCreation(reads) : null;
  const canCreate = creation === "allowed" && !!account?.onCompanyCreated;

  const renderEntry = (entry: ActiveEngagementEntry) => {
    const nextVisible = isStageCustomerVisible(entry.workspaceState.nextAction.mission);
    const stageLabel = nextVisible ? STAGE_CONFIGS[entry.workspaceState.nextAction.mission].label : TRIAL_BALANCE_REVIEW.title;
    const nextLabel = nextVisible
      ? entry.workspaceState.nextAction.label
      : trialBalanceReviewStep(entry.workspaceState)?.label ?? NO_VISIBLE_NEXT_ACTION;
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
            aria-label={`Resume ${entry.companyName} FY${entry.periodYear}`}
            className={`${account ? SECONDARY : PRIMARY} shrink-0`}
          >
            Resume <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />
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
      {account && next && (
        <section className="mb-10" aria-labelledby="account-home-title">
          <h1 id="account-home-title" className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-4">Your engagements</h1>
          <NextActionCard
            next={next}
            busy={pending !== null}
            onRetry={account.onRetry}
            onResume={() => { const e = entries.find((x) => next.kind === "resume" && x.engagementId === next.engagementId); if (e) onResume(e); }}
            onStartReview={() => { const u = unavailableEngagements.find((x) => next.kind === "start_review" && x.engagementId === next.engagementId); if (u) addReview(u); }}
            onStartService={() => { const c = companiesWithoutEngagement.find((x) => next.kind === "start_service" && x.id === next.companyId); if (c) onStartService(c); }}
            onOpenShared={sharedWorkspaces.length === 1 && onOpenShared ? () => onOpenShared(sharedWorkspaces[0]) : undefined}
            onAddCompany={canCreate ? () => setAddOpen(true) : undefined}
            addFormId={addFormId}
            pendingLabel={next.kind === "start_review" && pending === next.engagementId ? "Starting…" : null}
          />
        </section>
      )}
      {entries.length > 0 && (
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
            const { client, test } = groupEngagements(entries);
            const renderGroup = (g: CompanyGroup<ActiveEngagementEntry>) => (
              <li key={g.companyId} data-testid={`company-group-${g.companyId}`}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="text-[15px] font-semibold text-foreground">{g.companyName}</h3>
                  {g.distinguisher ? <span className="text-[12px] text-muted-foreground">({g.distinguisher})</span> : null}
                  <span className="text-[12px] text-muted-foreground" data-testid={`company-purpose-${g.companyId}`}>· {g.purpose ? PURPOSE_WORDS[g.purpose] : "Purpose not stated"}</span>
                  {onSetPurpose ? <PurposeControl companyId={g.companyId} current={g.purpose} onSet={onSetPurpose} /> : null}
                </div>
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
        </section>
      )}
      {account && (
        <section className="mb-10" data-testid="account-companies" aria-labelledby="account-companies-title">
          <h2 id="account-companies-title" className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">Companies</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {canCreate && !addOpen && (
              <Button variant="outline" onClick={() => setAddOpen(true)} aria-expanded={false} aria-controls={addFormId} data-testid="add-company" className={SECONDARY}>
                Add a company
              </Button>
            )}
            <Link to="/settings" data-testid="manage-companies" className="text-[13px] underline underline-offset-4 text-foreground">
              Manage companies in Settings
            </Link>
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
      {account && !account.billingLoading && !account.billingError && (
        <section className="mt-10" data-testid="account-plan">
          <CurrentPlanPanel billing={account.billing} capacity={account.capacity} loading={account.billingLoading} error={account.billingError} onRetry={account.onRetry} />
        </section>
      )}
    </>
  );

  if (account) return <AccountShell onSignOut={account.onSignOut}>{body}</AccountShell>;
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
function NextActionCard({ next, busy, onRetry, onResume, onStartReview, onStartService, onOpenShared, onAddCompany, addFormId, pendingLabel }: {
  next: AccountNextAction;
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
  const activation = SERVICE_ENQUIRY_SURFACES.contactRoute
    ? <Link to={activationRequestHref("plan_wall")} className="text-[13px] underline underline-offset-4" data-testid="next-action-activation">{REQUEST_ACTIVATION_LABEL}</Link>
    : null;
  const arrow = <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />;
  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  switch (next.kind) {
    case "retry": primary = <Button onClick={onRetry} className={PRIMARY} data-testid="next-action-primary">Try again</Button>; break;
    case "choose_plan":
    case "capacity_reached":
      primary = <Button asChild className={PRIMARY} data-testid="next-action-primary"><Link to="/plans">View plans{arrow}</Link></Button>;
      secondary = activation;
      break;
    case "resume": primary = <Button onClick={onResume} className={PRIMARY} data-testid="next-action-primary">Resume{arrow}</Button>; break;
    case "start_review": primary = <Button onClick={onStartReview} disabled={busy} aria-busy={!!pendingLabel} className={PRIMARY} data-testid="next-action-primary">{pendingLabel ?? `Start ${TRIAL_BALANCE_REVIEW.title}`}{arrow}</Button>; break;
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
      {(primary || secondary) && <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">{primary}{secondary}</div>}
    </div>
  );
}

/** The owner records a company's purpose with a reason (set_workspace_purpose; the server refuses anyone else). */
function PurposeControl({ companyId, current, onSet }: { companyId: string; current: WorkspacePurpose | null;
  onSet: (companyId: string, purpose: WorkspacePurpose, reason: string) => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<WorkspacePurpose>(current === "test" ? "client" : "test");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ids = { purpose: useId(), reason: useId() };
  if (!open) return <button type="button" className="text-[12px] underline text-muted-foreground" onClick={() => setOpen(true)} data-testid={`set-purpose-${companyId}`}>Change purpose</button>;
  return (
    <form className="mt-1 flex w-full flex-wrap items-end gap-2 text-[12px]" aria-label="Workspace purpose"
      onSubmit={async (e) => { e.preventDefault(); if (busy || reason.trim().length < 3) return; setBusy(true); try { setNotice(await onSet(companyId, purpose, reason.trim())); } finally { setBusy(false); } }}>
      <label htmlFor={ids.purpose}>Purpose</label>
      <select id={ids.purpose} className="border border-input bg-background px-1 py-0.5" value={purpose} onChange={(e) => setPurpose(e.target.value as WorkspacePurpose)}>
        {(Object.keys(PURPOSE_WORDS) as WorkspacePurpose[]).map((p) => <option key={p} value={p}>{PURPOSE_WORDS[p]}</option>)}
      </select>
      <label htmlFor={ids.reason}>Reason</label>
      <input id={ids.reason} className="min-w-[12rem] flex-1 border border-input bg-background px-1 py-0.5" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" className="border border-input px-2 py-0.5 disabled:opacity-50" disabled={busy || reason.trim().length < 3}>{busy ? "Recording…" : "Record"}</button>
      <button type="button" className="px-2 py-0.5 underline" onClick={() => setOpen(false)}>Cancel</button>
      {notice ? <p role="status" className="w-full text-muted-foreground">{notice}</p> : null}
    </form>
  );
}
