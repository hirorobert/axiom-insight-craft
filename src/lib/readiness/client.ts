/**
 * "Check my books": the browser's client. It READS the status and WRITES only evidence and proposals through server functions
 * (rfr_set_scope, rfr_register_input, rfr_propose_correction); the engine runs on the server (Edge Function rfr-check-books).
 * The browser never writes a financial or readiness table. Amounts are exact minor-unit strings.
 */
import type { ReadinessResult, ScopeFacts } from "../../../supabase/functions/_shared/readiness/types";

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Invoke = (name: string, body: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface ReadinessStatus {
  state: "unavailable" | "no_authority" | "period_unknown" | "not_enabled" | "not_evaluated" | "stale" | "current";
  /** The certified trial balance's own reporting period; never guessed by the page. */
  period?: { start: string; end: string; currency: string; exponent: number };
  scope?: { rulePackId: string; rulePackVersion: string; facts: ScopeFacts };
  contentSha256?: string;
  run?: { id: string; at: string; contentSha256: string; balancesAgree: boolean; result: ReadinessResult } | null;
  qboBound?: boolean;
  attestation?: { outcome: "confirmed" | "changed"; pulledAt: string; expiresAt: string; boundContentSha256: string } | null;
  inputs?: { family: string; key: string; source: string; payloadSha256: string; at: string }[];
}
export interface CorrectionProposal {
  correctionId: string; scope: string; anchor: string[]; bundle: string | null; supersedes?: string | null; reason: string; evidenceRef: string | null;
  lines: { accountKey: string; debitMinor: string; creditMinor: string }[]; reversesCorrection?: string | null;
}
export type RegisterOutcome = "recorded" | "unchanged" | "forbidden" | "feature_disabled" | "not_enabled" | "invalid_request" | "request_reused" | "not_found";
export type ProposeCorrectionOutcome = "proposed" | "already_proposed" | "forbidden" | "not_enabled" | "invalid_request" | "no_authority" | "unbalanced" | "unknown_account" | "not_reversible" | "request_reused" | "feature_disabled";
export type CheckOutcome = "recorded" | "not_enabled" | "no_authority" | "period_unknown" | "input_changed" | "invalid_request" | "forbidden" | "unauthenticated" | "unavailable";

export const REGISTER_WORDS: Record<Exclude<RegisterOutcome, "recorded" | "unchanged">, string> = {
  forbidden: "Importing needs Prepare in this workspace. Nothing was recorded.", feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
  not_enabled: "Start checking this period first. Nothing was recorded.", invalid_request: "The file could not be recorded as sent. Nothing was recorded.",
  request_reused: "This was already sent with different content. Reload and try again.", not_found: "There was nothing to withdraw.",
};
export const PROPOSE_CORRECTION_WORDS: Record<Exclude<ProposeCorrectionOutcome, "proposed" | "already_proposed">, string> = {
  forbidden: "Proposing a correction needs Prepare in this workspace. Nothing was recorded.", not_enabled: "Start checking this period first. Nothing was recorded.",
  invalid_request: "The correction is not valid. Nothing was recorded.", no_authority: "There is no reviewed trial balance for this period.", unbalanced: "The correction does not balance. Nothing was recorded.",
  unknown_account: "An account is not classified in this workspace. Classify it in Account review first.", not_reversible: "Only an approved correction can be reversed, once.",
  request_reused: "This was already sent with different content. Reload and try again.", feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
};
export const CHECK_WORDS: Record<Exclude<CheckOutcome, "recorded">, string> = {
  not_enabled: "Start checking this period first.", no_authority: "There is no reviewed trial balance for this period yet.", period_unknown: "The reporting period of the trial balance is not known.",
  input_changed: "The books changed while they were being checked. Check again.", invalid_request: "The request was not valid.", forbidden: "Checking needs Prepare in this workspace.",
  unauthenticated: "Please sign in again.", unavailable: "The check could not be completed. Nothing was recorded.",
};

export function readinessClient(db: { rpc: Rpc }, invoke: Invoke) {
  const call = async <T>(name: string, args: Record<string, unknown>, what: string): Promise<T> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(`${what} could not be completed. Nothing was recorded.`);
    return data as T;
  };
  return {
    status: (companyId: string, periodYear: number) => call<ReadinessStatus>("rfr_status", { p_company_id: companyId, p_period_year: periodYear }, "Reading the status"),
    accounts: async (companyId: string, periodYear: number) => {
      const rows = await call<{ account_key: string; account_code: string | null; account_name: string }[] | null>("close_review_adjusted_trial_balance", { p_company_id: companyId, p_period_year: periodYear }, "Reading the accounts");
      return (rows ?? []).map((r) => ({ key: r.account_key, code: r.account_code, name: r.account_name }));
    },
    start: (companyId: string, periodYear: number, facts: ScopeFacts) =>
      call<{ outcome: string; enabled?: boolean }>("rfr_set_scope", { p_company_id: companyId, p_period_year: periodYear, p_rule_pack_id: "rfr-pilot-ipsas-accrual", p_rule_pack_version: "1.0.0", p_facts: facts, p_reason: "Started checking this period from Check my books" }, "Starting the check"),
    register: (companyId: string, periodYear: number, family: string, key: string, payload: object, fileSha256: string | null, requestId: string) =>
      call<{ outcome: RegisterOutcome; inputId?: string }>("rfr_register_input", { p_company_id: companyId, p_period_year: periodYear, p_family: family, p_key: key, p_payload: payload, p_source: "export_file", p_file_sha256: fileSha256, p_request_id: requestId }, "The import"),
    propose: (companyId: string, periodYear: number, c: CorrectionProposal, requestId: string) =>
      call<{ outcome: ProposeCorrectionOutcome; adjustmentId?: string; status?: string }>("rfr_propose_correction", {
        p_company_id: companyId, p_period_year: periodYear, p_correction_id: c.correctionId, p_scope: c.scope, p_anchor: c.anchor, p_reason: c.reason, p_evidence_ref: c.evidenceRef,
        p_lines: c.lines, p_request_id: requestId, p_reverses_correction: c.reversesCorrection ?? null, p_bundle: c.bundle, p_supersedes: c.supersedes ?? null,
      }, "The proposal"),
    check: async (companyId: string, periodYear: number): Promise<CheckOutcome> => {
      const { data, error } = await invoke("rfr-check-books", { companyId, periodYear });
      const outcome = (data as { outcome?: string } | null)?.outcome;
      if (outcome) return outcome as CheckOutcome;
      return error ? "unavailable" : "unavailable";
    },
  };
}
export type ReadinessClient = ReturnType<typeof readinessClient>;
