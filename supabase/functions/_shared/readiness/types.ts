/**
 * Ready for Reporting — contract types (rfr-acceptance/2).
 *
 * Pure data shapes shared by the engine, the edge function, the browser and the acceptance adapter. Money is a signed
 * decimal string of minor units, debit positive. Nothing here defaults a missing input: an absent fact is absent.
 */
export type Minor = string;

export interface Period { start: string; end: string; currency: string; exponent: number }
export interface TbAccount { closing: Minor; note?: string }
export interface Tb { validated: boolean; accounts: Record<string, TbAccount> }

export interface LedgerEntry { id: string; date: string; account: string; amount: Minor; ref?: string; links?: string[]; constructed_aggregate?: boolean }
export interface Ledger { snapshot: string; scope_limited?: boolean; accounts: Record<string, Minor>; entries: LedgerEntry[] }

/** How an extracted fact was established. Only the first two are probative; neither makes a fact relevant. */
export type Extraction = "human_confirmed" | "reproduced" | "ai_unconfirmed";
export type Facts = Record<string, string | undefined>;
export interface Evidence { kind: string; facts?: Facts; extraction: Extraction }

export interface StatementRow { date: string; amount: Minor; balance?: Minor; ref?: string; kind?: string; excerpt_restart?: boolean; note?: string }
export interface Statement { file: string; sha: string; from: string; to: string; pages_total?: number | null; pages_missing?: number[]; opening?: Minor | null; rows?: StatementRow[] }
export interface Outstanding { entry_id: string; cleared_by: string; request?: string }
export interface Bank {
  id: string; ledger_key: string | null; status: "active" | "dormant" | "closed";
  statements?: Statement[]; match?: { window_days?: number }; outstanding?: Outstanding[]; reconciling_bank_items?: string[];
  closure_evidence?: string; period_end_confirmation?: string | null; supplied_pages_all_matched?: boolean;
}
export interface Population { ledger?: string[]; prior_year?: string[]; confirmations?: string[]; statements?: string[]; banks_requiring_confirmation?: string[]; confirmation_complete?: Record<string, boolean> }

export interface Line { account: string; amount: Minor }
export interface BridgeLine {
  line: string; approved: Minor; accounts: string[]; level: "line" | "account" | "subledger" | "item"; ledger_opening?: Minor;
  classification?: { kind: "mapping" | "timing" | "unposted_audit_adjustment" | "possible_prior_period_error" | "other_evidenced"; evidence?: string[]; approved_by?: string };
}
export interface OpeningBridge { basis: string; lines: BridgeLine[]; proposals?: { id: string; line: string; lines: Line[] }[] }

export interface CutoffItem { ref: string; grn_ref?: string; amount: Minor; evidence: string; receipt_evidence: string; expense_account: string; accrual_account: string }
export interface Cutoff { search?: { from: string; to?: string; required_to: string; basis?: string; sources: string[] } | null; items?: CutoffItem[]; bank_reconciliation_clean?: boolean; request?: string }

export interface DoubleCharge {
  amount: Minor; cheque: string; bill: string; payee: string; payment_evidence: string; gl_entry_id: string; expense_account: string; payable_account: string;
  voucher: string; supplier_confirmation: string; approved_fs: string; bridge_line: string; correction_id: string; cash_account?: string;
}

export interface AdjustmentRow { id: string; correction_id?: string; approved?: boolean; lines: Line[]; scope?: string; reverses?: string | null; note?: string }
export interface Approval { id: string; proposer: string; approver: string; approver_caps?: string[] }
export interface CorrectionVerification {
  id: string; scope: string; effect: Line[]; anchor: string[]; adjustment_approved?: boolean; previous_state?: string | null;
  snapshot: { id: string; postings: { id: string; lines: Line[]; links?: string[] }[] };
}

export interface ScopeFacts {
  banks?: string[]; banks_requiring_confirmation?: string[]; deposits?: boolean; opening_lines?: string[]; opening_equity?: boolean;
  suspense_accounts?: string[]; liabilities_completeness?: boolean; payables_settlement?: boolean;
}

export interface Attestation {
  id?: string; pulled_at: string; expires_at: string; outcome: "confirmed" | "changed";
  tb_fingerprint: string; gl_fingerprint?: string; bound_content_sha256: string;
}
export interface Freshness {
  source: "qbo" | "export"; now?: string; bound?: { tb_fingerprint?: string; gl_fingerprint?: string }; attestation?: Attestation | null;
}

export interface ReadinessInput {
  period: Period; tb?: Tb; ledger?: Ledger | null; evidence?: Record<string, Evidence | undefined>;
  scope_facts?: ScopeFacts; required_scopes?: string[]; gl_dependent_scopes?: string[];
  population?: Population; banks?: Bank[];
  deposit?: { approved_opening: Minor; movements: { amount: Minor; evidence: string; receiving_account: string }[]; history?: { evidence: string; amount: Minor }[]; closing_evidenced: Minor | null; request?: string };
  opening_bridge?: OpeningBridge; entry_support?: { accounts: string[] };
  obe_reconstruction?: { tb_obe: Minor; journals: { ref: string; amount: Minor }[]; reconstructed: Minor; source_export: string | null; request?: string; account?: string };
  cutoff?: Cutoff; double_charge?: DoubleCharge;
  correction_verification?: CorrectionVerification[];
  reporting_adjustments?: AdjustmentRow[]; apply_proposals?: string[]; approvals?: Approval[];
  evidence_uses?: { evidence: string; line: string }[];
  decisions?: { action: string; scope: string; evidence?: string[]; need?: Record<string, unknown> }[];
  citations?: { rule: string; framework: string; provision: string; status: string }[];
  content_sha256_now?: string; review?: { reviewed_content_sha256?: string } | null; freshness?: Freshness;
}

export type Outcome = "confirmed" | "suspected" | "evidence_missing" | "incomplete" | "pass";
export interface Finding { rule: string; outcome: Outcome; scope: string; resolves?: string; resolved_by?: string; accounts?: string[]; detail?: Record<string, unknown> }
export interface Proposal { id: string; scope: string; lines: Line[] }
export interface CorrectionState { id: string; state: string; adjustment_applied: boolean; residual: Record<string, string> | null }
export interface Refusal { action: string; code: string }

export interface ReadinessResult {
  draft_eligible: boolean; evidence_upload_allowed: true; required_scopes: string[];
  findings: Finding[]; scopes: Record<string, "READY" | "HELD">; scope_reasons: Record<string, string[]>;
  proposals: { id: string; lines: Line[] }[]; corrections: CorrectionState[]; applied_adjustments: string[];
  balances: Record<string, Minor>; refusals: Refusal[]; finalization: { held: boolean; reasons: string[] };
}

/** Raised for malformed input (not a bad accounting position): the caller must fix the request. */
export class ReadinessInputError extends Error {}
