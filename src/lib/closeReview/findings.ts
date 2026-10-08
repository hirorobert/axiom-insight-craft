/**
 * Close Review findings (I2): the browser's model and client. The database decides everything — which findings exist
 * (close_review_refresh_findings, on the authoritative trial balance only), every lifecycle action
 * (close_review_finding_action) and the summary (close_review_findings_summary). This module only reads and words it.
 * The status and resolution rules below MIRROR the database's (close_review_finding_status / _resolved) for display;
 * the database's answer always wins.
 */
import type { TimelineEventRow } from "./timeline";

export type FindingRule = "A01" | "A03" | "A10" | "T01";
export type FindingStatus = "open" | "explained" | "accepted" | "not_applicable" | "adjusted";
export type FindingAction = "explain" | "accept" | "not_applicable" | "reopen";

export type RuleKind = "deterministic_error" | "risk_indicator" | "evidence_requirement";
export type RuleStatus = "evaluated" | "not_evaluated" | "not_required" | "excluded";

/**
 * tb-anomaly-catalogue/1 as reviewed: every rule's kind and its default status (T01 is evaluated only where a reviewed
 * requirement scopes it; A04 also needs an authoritative prior year). Pinned to the migration by findings.test.ts.
 * The catalogue is not a complete error detector: only "evaluated" rules can raise findings.
 */
export const CATALOGUE: Readonly<Record<string, { kind: RuleKind; status: RuleStatus | "scoped" }>> = {
  A01: { kind: "risk_indicator", status: "evaluated" },
  A02: { kind: "risk_indicator", status: "not_evaluated" },
  A03: { kind: "deterministic_error", status: "evaluated" },
  A04: { kind: "deterministic_error", status: "not_evaluated" },
  A05: { kind: "risk_indicator", status: "not_evaluated" },
  A06: { kind: "risk_indicator", status: "not_evaluated" },
  A07: { kind: "deterministic_error", status: "excluded" },
  A08: { kind: "risk_indicator", status: "not_evaluated" },
  A09: { kind: "risk_indicator", status: "not_evaluated" },
  A10: { kind: "risk_indicator", status: "evaluated" },
  T01: { kind: "evidence_requirement", status: "scoped" },
};
export const KIND_WORDS: Record<RuleKind, string> = { deterministic_error: "Error", risk_indicator: "Risk indicator", evidence_requirement: "Evidence needed" };
export const RULE_STATUS_WORDS: Record<RuleStatus, string> = { evaluated: "Checked", not_evaluated: "Not evaluated", not_required: "Not required here", excluded: "Cannot occur" };

export interface FindingRow {
  id: string;
  run_id: string;
  rule_id: FindingRule;
  finding_key: string;
  severity: "blocking" | "warning";
  kind: RuleKind;
  mandatory: boolean;
  required_resolution: "explanation" | "evidence" | "review";
  account_key: string | null;
  account_code: string | null;
  account_name: string | null;
  classification: string | null;
  debit_minor: string | null;
  credit_minor: string | null;
  class_side_minor: string | null;
  detail: Record<string, unknown>;
}

export type FindingsSummary =
  | { state: "unavailable" | "no_authority" | "not_generated" | "stale" }
  | { state: "current"; runId: string; currency: string; exponent: number; generatedAt: string; total: number; unresolved: number; unresolvedBlocking: number;
      ruleStatus: Record<string, { evaluated: boolean; kind?: RuleKind; status?: RuleStatus; reason?: string }> };

export const RULE_WORDS: Record<string, { title: string; explain: string }> = {
  A01: { title: "Balance on the unexpected side", explain: "The balance is on the side opposite to its class (an asset or expense in credit, or a liability, equity or income account in debit)." },
  A02: { title: "Suspense or clearing account open", explain: "A suspense, clearing or control account still carries a balance." },
  A03: { title: "Cash account in credit", explain: "An account designated as cash is in credit while presented as an asset — it may need to be shown as an overdraft." },
  A04: { title: "Retained earnings do not roll forward", explain: "Opening retained earnings plus profit less distributions should equal closing retained earnings." },
  A05: { title: "New or vanished accounts", explain: "Accounts present in only one of the two years." },
  A06: { title: "Unexplained year-on-year movement", explain: "Movements above the framework's threshold need an explanation." },
  A07: { title: "Duplicate account identity", explain: "The same account name on different codes." },
  A08: { title: "Round amounts", explain: "Exact round balances can indicate estimates." },
  A09: { title: "Statutory liability in debit", explain: "Payroll or sales-tax type liabilities with a debit balance." },
  A10: { title: "Classification is a machine suggestion", explain: "The account was certified on an automatic suggestion; confirm it is right." },
  T01: { title: "Income-tax computation workpaper", explain: "Tax figures come from the reviewed trial balance; attach your computation workpaper as evidence." },
};

export const RESOLUTION_WORDS: Record<FindingRow["required_resolution"], string> = {
  explanation: "Needs an explanation",
  evidence: "Needs your workpaper as evidence",
  review: "Needs a correction (reclassify in Account review, or an approved adjustment)",
};

export const STATUS_WORDS: Record<FindingStatus, string> = {
  open: "Open", explained: "Explained", accepted: "Accepted", not_applicable: "Not applicable", adjusted: "Adjusted",
};

const LIFECYCLE: Record<string, FindingStatus> = {
  finding_explained: "explained", finding_accepted: "accepted", finding_not_applicable: "not_applicable", finding_reopened: "open",
};

/** The latest lifecycle event decides (open when none) — the database's rule. */
export function findingStatus(events: readonly TimelineEventRow[]): FindingStatus {
  const life = events.filter((e) => e.event_type in LIFECYCLE).sort((a, b) => a.seq - b.seq);
  return life.length ? LIFECYCLE[life[life.length - 1].event_type] : "open";
}

/** Resolved for publication — the database's rule (blocking findings resolve only by their required resolution). */
export function findingResolved(f: Pick<FindingRow, "severity" | "required_resolution">, events: readonly TimelineEventRow[]): boolean {
  const s = findingStatus(events);
  if (f.severity === "warning") return s !== "open";
  if (f.required_resolution === "explanation") return s === "explained" || s === "adjusted";
  if (f.required_resolution === "evidence") {
    const last = [...events].filter((e) => e.event_type === "finding_explained").sort((a, b) => b.seq - a.seq)[0];
    return s === "explained" && !!last && typeof (last.detail ?? {}).evidenceRef === "string";
  }
  return s === "adjusted";
}

/** Which actions to OFFER (the database still decides each one). */
export function offeredActions(f: Pick<FindingRow, "mandatory">, status: FindingStatus, allowed: readonly string[]): FindingAction[] {
  const out: FindingAction[] = [];
  if (status === "open") {
    if (allowed.includes("prepare_close")) out.push("explain");
    if (allowed.includes("review_close") && !f.mandatory) out.push("accept", "not_applicable");
  } else if (allowed.includes("review_close")) out.push("reopen");
  return out;
}

export type ActionOutcome = "recorded" | "forbidden" | "feature_disabled" | "not_found" | "stale_authority" | "mandatory_finding"
  | "evidence_required" | "invalid_request" | "invalid_transition" | "request_reused";
export const ACTION_REFUSALS: Record<Exclude<ActionOutcome, "recorded">, string> = {
  forbidden: "You don't have the capability for this action in this workspace. Nothing was recorded.",
  feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
  not_found: "This finding is no longer available.",
  stale_authority: "The trial balance changed since these findings were generated. Check for findings again.",
  mandatory_finding: "This finding is mandatory: it cannot be accepted or marked not applicable.",
  evidence_required: "Add the reference of your workpaper (document name and version, or its fingerprint).",
  invalid_request: "Write between 3 and 4,000 characters.",
  invalid_transition: "This finding changed since you opened it. Reload to see its current status.",
  request_reused: "This was already sent with different content. Reload and try again.",
};

export type RefreshOutcome = "generated" | "unchanged" | "forbidden" | "feature_disabled" | "no_authority" | "legacy_certification" | "currency_unknown" | "invalid_request";
export const REFRESH_WORDS: Record<RefreshOutcome, string> = {
  generated: "Findings checked against the current reviewed trial balance.",
  unchanged: "Nothing changed: these are the findings of the current reviewed trial balance.",
  forbidden: "Checking for findings needs Prepare in this workspace.",
  feature_disabled: "Close Review is not enabled for this workspace.",
  no_authority: "There is no reviewed trial balance for this period yet.",
  legacy_certification: "This trial balance was checked before exact amounts were recorded. Run its check again first.",
  currency_unknown: "This period has no reporting currency. Set it in Trial Balance › Intake first.",
  invalid_request: "The request was not valid. Nothing was recorded.",
};

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type From = (table: string) => {
  select(c: string): { eq(c: string, v: string): { order(c: string, o: { ascending: boolean }): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
                       in(c: string, v: string[]): { eq(c: string, v: string): { order(c: string, o: { ascending: boolean }): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } } };
};

export function findingsClient(db: { rpc: Rpc; from: From }) {
  const ok = <T>(r: { data: unknown; error: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what} could not be read.`); return r.data as T; };
  return {
    summary: async (companyId: string, periodYear: number) => ok<FindingsSummary>(await db.rpc("close_review_findings_summary", { p_company_id: companyId, p_period_year: periodYear }), "The findings"),
    refresh: async (companyId: string, periodYear: number) => ok<{ outcome: RefreshOutcome; runId?: string }>(await db.rpc("close_review_refresh_findings", { p_company_id: companyId, p_period_year: periodYear }), "The check"),
    list: async (runId: string) => ok<FindingRow[]>(await db.from("close_review_findings").select("*").eq("run_id", runId).order("finding_key", { ascending: true }), "The findings") ?? [],
    events: async (findingIds: string[]) => findingIds.length === 0 ? [] :
      ok<(TimelineEventRow & { subject_id: string })[]>(await db.from("close_review_events").select("id, seq, event_type, body, revises_event_id, detail, actor_user_id, created_at, subject_id")
        .in("subject_id", findingIds).eq("subject_kind", "finding").order("seq", { ascending: true }), "The history") ?? [],
    /** The database's status and resolution of every finding of the current run (adjustment contracts included). */
    states: async (companyId: string, periodYear: number) =>
      ok<{ finding_id: string; status: FindingStatus; resolved: boolean }[]>(await db.rpc("close_review_finding_states", { p_company_id: companyId, p_period_year: periodYear }), "The finding states") ?? [],
    act: async (findingId: string, action: FindingAction, text: string, evidenceRef: string | null, requestId: string) =>
      ok<{ outcome: ActionOutcome; status?: FindingStatus }>(await db.rpc("close_review_finding_action", { p_finding_id: findingId, p_action: action, p_text: text, p_evidence_ref: evidenceRef, p_request_id: requestId }), "The action"),
  };
}
export type FindingsClient = ReturnType<typeof findingsClient>;
