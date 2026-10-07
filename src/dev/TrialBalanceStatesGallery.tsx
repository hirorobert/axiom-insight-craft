/**
 * Development-only gallery of the Prepare Data trial-balance surfaces and the account home, rendered by the REAL
 * components from neutral synthetic data. Not part of the application: no route in App.tsx, not imported by anything
 * under src/ outside src/dev/, and served only by the Vite dev server through dev/trial-balance-states.html (the
 * production build's only input is index.html). No account reads or writes: nothing calls the server. Proven by src/dev/devGalleryIsolation.test.ts and the production-bundle scan.
 *
 *   /dev/trial-balance-states.html?state=blocked|accepted|accepted-tolerance|failed|review|home
 *   &authority=recheck|legacy|stopped|retry|checking   — the processing-authority notice and history under the card (F2)
 */
import { useSearchParams } from "react-router-dom";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { CurrentTrialBalanceCard } from "@/components/workspace/CurrentTrialBalanceCard";
import { TrialBalanceChecks } from "@/components/workspace/TrialBalanceChecks";
import { UploadHistory } from "@/components/workspace/UploadHistory";
import { ProcessingAuthorityNoticeView } from "@/components/workspace/ProcessingAuthorityNoticeView";
import { parseUploadAuthority, type AttemptHistoryEntry } from "@/lib/workspace/uploadAuthority";
import { ManageTrialBalance } from "@/components/workspace/ManageTrialBalance";
import { deriveTrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";
import type { PreflightCheck, PreflightVerdict } from "@/lib/workspace/computePreflight";
import EngagementHub from "@/pages/workspace/EngagementHub";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import type { BillingSummary } from "@/hooks/useBillingSummary";

const HOME_BILLING: BillingSummary = {
  hasBillingCustomer: true, planCode: "PRACTICE", licenceStatus: "ACTIVE", effectiveStart: "2026-09-01", effectiveEnd: "2027-08-31",
  billingInterval: "ANNUAL", billingIntervalCount: 1, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null,
  nextBillingInterval: null, nextBillingIntervalCount: null, entitlements: [],
};
const HOME_ENTRY: ActiveEngagementEntry = {
  engagementId: "synthetic-engagement", companyId: "synthetic-company", companyName: "Sample Trading Ltd", periodYear: 2025,
  engagementType: "composite", framework: "IPSAS accrual", capabilities: ["FINANCIAL_STATEMENTS"], openedAt: "2026-09-20T00:00:00Z",
  workspaceState: deriveWorkspaceState("synthetic-company", "Sample Trading Ltd", 2025, null),
};

const L = (id: string, state: PreflightCheck["state"], detail = ""): PreflightCheck => ({ id, label: id, state, detail });
const INFO = [L("l5_supporting_evidence", "pending", "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload"), L("l6_prior_period", "pending", "NO_PRIOR: no authoritative certification exists for period 2024")];
const MAPPED = { mapping_completeness: { total_accounts: 180, mapped_accounts: 180, needs_review: 0 } };

const STATES: Record<string, { status: string; verdict: PreflightVerdict; blocker: string | null; checks: PreflightCheck[]; tb: { total_debits: number; total_credits: number; difference: number } | null; mapping?: object }> = {
  blocked: {
    status: "blocked", verdict: "blocked", blocker: "Debits 1250000.00 != Credits 1247500.00 (difference: 2500.00)",
    checks: [L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "failed", "Debits 1250000.00 != Credits 1247500.00 (difference: 2500.00)"), L("l4_classification", "passed"), ...INFO],
    tb: { total_debits: 1250000.00, total_credits: 1247500.00, difference: 2500.00 },
  },
  accepted: {
    status: "complete", verdict: "certified", blocker: null,
    checks: [L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "passed"), L("l4_classification", "passed"), ...INFO],
    tb: { total_debits: 980000, total_credits: 980000, difference: 0 },
  },
  "accepted-tolerance": {
    status: "complete", verdict: "certified", blocker: null,
    checks: [L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "passed"), L("l4_classification", "passed"), ...INFO],
    tb: { total_debits: 980000.6, total_credits: 980000, difference: 0 },
  },
  failed: { status: "error", verdict: "pending", blocker: null, checks: [], tb: null },
  review: {
    status: "needs_review", verdict: "review", blocker: "12 accounts still need a classification decision.",
    checks: [L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "passed"), L("l4_classification", "review", "12 accounts still need a classification decision."), ...INFO],
    tb: { total_debits: 980000, total_credits: 980000, difference: 0 },
    mapping: { mapping_completeness: { total_accounts: 180, mapped_accounts: 168, needs_review: 12 } },
  },
};

const HISTORY = [
  { id: "h1", file_name: "sample_trial_balance_FY2025.xlsx", uploaded_at: "2026-09-30T10:40:00Z", status: "blocked", lifecycle_state: "blocked" },
  { id: "h2", file_name: "sample_trial_balance_v1.xls", uploaded_at: "2026-09-30T10:36:00Z", status: "blocked", lifecycle_state: "superseded" },
  { id: "h3", file_name: "TB.xlsx", uploaded_at: "2026-09-27T15:02:00Z", status: "blocked", lifecycle_state: "retired" },
  { id: "h4", file_name: "sample_trial_balance_draft.csv", uploaded_at: "2026-09-20T05:13:00Z", status: "complete", lifecycle_state: "superseded" },
];

const AUTHORITY: Record<string, Record<string, unknown>> = {
  recheck: { reason: "dependency_changed", current_attempt_status: "completed" },
  legacy: { reason: "legacy_certification", current_attempt_status: null },
  stopped: { reason: "attempt_failed", current_attempt_status: "failed", current_attempt_code: "INVARIANT_VIOLATION" },
  retry: { reason: "attempt_running", current_attempt_status: "running", current_attempt_lease_expired: true },
  checking: { reason: "attempt_running", current_attempt_status: "running" },
};
const ATTEMPTS: AttemptHistoryEntry[] = [
  { attemptNo: 3, status: "failed", code: "INVARIANT_VIOLATION", startedAt: "2026-10-07T09:12:00Z", completedAt: "2026-10-07T09:12:04Z" },
  { attemptNo: 2, status: "abandoned", code: "PREEMPTED", startedAt: "2026-10-07T09:05:00Z", completedAt: "2026-10-07T09:11:58Z" },
  { attemptNo: 1, status: "completed", code: null, startedAt: "2026-10-06T16:40:00Z", completedAt: "2026-10-06T16:40:03Z" },
];

export default function TrialBalanceStatesGallery() {
  const [params] = useSearchParams();
  if (!import.meta.env.DEV) return null;
  const key = params.get("state") ?? "blocked";
  if (key === "home") {
    return (
      <EngagementHub
        entries={[HOME_ENTRY]}
        companiesWithoutEngagement={[]}
        onResume={() => undefined}
        onStartService={() => undefined}
        account={{
          billing: HOME_BILLING, billingLoading: false, billingError: false,
          capacity: { capacity: 5, used: 2, planCode: "PRACTICE", determined: true }, capacityLoading: false, capacityError: false,
          onRetry: () => undefined, onSignOut: () => undefined,
        }}
      />
    );
  }
  const s = STATES[key] ?? STATES.blocked;
  const verdict = deriveTrialBalanceVerdict({
    upload: { status: s.status, processing_result: { validation_report: { ...(s.mapping ?? MAPPED), ...(s.tb ? { tb_balance_check: s.tb } : {}) } } },
    readiness: { verdict: s.verdict, blocker: s.blocker, checks: s.checks },
    canRetry: true,
  });
  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center gap-3 border-b border-border px-4 sm:px-6">
        <CFOCloseWordmark className="text-base" />
        <span className="truncate text-[13px] font-semibold text-foreground">Sample Trading Ltd</span>
        <span className="hidden text-[12px] text-muted-foreground sm:inline">FY2025 · IPSAS accrual</span>
      </header>
      <main className="mx-auto max-w-5xl space-y-5 px-4 pb-10 pt-6 sm:px-6">
        <header className="border-b border-border pb-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Prepare data · FY2025</p>
          <h1 className="mt-1 text-xl font-semibold text-foreground">Trial balance</h1>
        </header>
        <CurrentTrialBalanceCard
          fileName="sample_trial_balance_FY2025.xlsx"
          uploadedAt="2026-09-30T10:40:00Z"
          fileSize={21_000}
          verdict={verdict}
          onPrimary={() => undefined}
          management={
            <ManageTrialBalance variant="inline" hideReplace={verdict.primaryAction?.kind === "replace"} mode="manage" removeAction={{ kind: "remove" }}
              replacing={false} removing={false} focusRequested={false} onReplace={() => undefined} onRemove={() => undefined} />
          }
        />
        {params.get("authority") && AUTHORITY[params.get("authority")!] && (
          <ProcessingAuthorityNoticeView
            state={{
              loaded: true,
              authority: parseUploadAuthority({ upload_id: "h1", authoritative: false, certification_id: "c", current_attempt_code: null,
                current_attempt_lease_expired: false, processing_attempt: 3, ...AUTHORITY[params.get("authority")!] }),
              attempts: ATTEMPTS,
            }}
            busy={false}
            canAct={verdict.primaryAction?.kind !== "retry"}
            onAction={() => undefined}
          />
        )}
        <TrialBalanceChecks verdict={verdict} />
        <section className="border border-border bg-card px-5 py-3.5 text-[13px] font-semibold text-foreground sm:px-7">Technical processing details</section>
        <UploadHistory uploads={HISTORY} currentId="h1" viewingId="h1" onOpen={() => undefined} />
      </main>
    </div>
  );
}
