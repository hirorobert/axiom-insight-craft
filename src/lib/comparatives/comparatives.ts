// comparatives/comparatives.ts — the browser's view of the database's comparative state (fs_comparatives_status,
// 20261020100000) and the server calls that change it: account bridges, restatements (proposal and two-person decision),
// and approval of the comparative. The database decides every state; nothing is computed or written here.

import { z } from "zod";

export const COMPARATIVE_STATES = [
  "approved", "unapproved", "approval_stale", "accounts_not_presented", "unbalanced",
  "different_currency", "reference_only", "missing", "first_period_exception",
] as const;
export type ComparativeState = (typeof COMPARATIVE_STATES)[number];

const statusSchema = z.object({
  state: z.literal("evaluated"),
  comparative: z.object({
    contract: z.literal("fs-comparatives-status/1"), periodYear: z.number().int(), state: z.enum(COMPARATIVE_STATES),
    composedComparativeState: z.string(), required: z.boolean(), firstPeriodDeclared: z.boolean(),
    comparativeSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), compositionSha256: z.string().regex(/^[0-9a-f]{64}$/),
    approval: z.object({ id: z.string(), action: z.enum(["approved", "withdrawn"]), comparativeSha256: z.string().nullable(), by: z.string(), at: z.string() }).nullable(),
    blockers: z.array(z.string()),
  }),
  statusSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ComparativeStatus = z.infer<typeof statusSchema>;

export function parseComparativeStatus(payload: unknown): ComparativeStatus | { state: string } {
  const ok = statusSchema.safeParse(payload);
  if (ok.success) return ok.data;
  const s = (payload as { state?: unknown } | null)?.state;
  if (typeof s === "string" && s !== "evaluated") return { state: s };
  throw new Error(`fs_comparatives_status returned an unrecognised payload: ${ok.error.issues[0]?.message ?? "invalid"}`);
}

/** What each state means for the reader — one sentence each, never merged, never softened. */
export const COMPARATIVE_WORDS: Readonly<Record<ComparativeState, { readonly title: string; readonly detail: string; readonly satisfiesRequirement: boolean }>> = {
  approved: { title: "Approved", detail: "The prior-year figures shown are approved as they stand now.", satisfiesRequirement: true },
  unapproved: { title: "Not yet approved", detail: "The prior-year figures are available but a reviewer has not approved them.", satisfiesRequirement: false },
  approval_stale: { title: "Approval out of date", detail: "Something changed after approval (a restatement or a bridge); approve the figures again.", satisfiesRequirement: false },
  accounts_not_presented: { title: "Prior-year accounts not presented", detail: "Some prior-year accounts are not on any line; bridge them to this year's accounts.", satisfiesRequirement: false },
  unbalanced: { title: "Prior year does not balance", detail: "The prior-year statement of financial position does not balance as presented.", satisfiesRequirement: false },
  different_currency: { title: "Different currency", detail: "The prior year is in another currency; translation is not supported yet, so it cannot be approved.", satisfiesRequirement: false },
  reference_only: { title: "Reference only", detail: "Prior-year statements are held as evidence only; they are shown for reference and never count as approved comparatives.", satisfiesRequirement: false },
  missing: { title: "Missing", detail: "There is no authoritative prior-year trial balance; comparatives are required.", satisfiesRequirement: false },
  first_period_exception: { title: "First reporting period", detail: "An approved first-period declaration is in force; no comparatives are required.", satisfiesRequirement: true },
};

export interface RestatementLine { lineId: string; section: string; deltaMinor: string }

export interface ComparativesDb { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }

export function comparativesClient(db: ComparativesDb) {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as { outcome: string; [k: string]: unknown };
  };
  return {
    status: async (companyId: string, periodYear: number) =>
      parseComparativeStatus((await db.rpc("fs_comparatives_status", { p_company_id: companyId, p_period_year: periodYear })).data),
    bridge: (companyId: string, periodYear: number, priorAccountKey: string, currentAccountKey: string | null, reason: string, requestId: string) =>
      call("fs_bridge_comparative_account", { p_company_id: companyId, p_period_year: periodYear, p_prior_account_key: priorAccountKey, p_current_account_key: currentAccountKey, p_reason: reason, p_request_id: requestId }),
    proposeRestatement: (companyId: string, periodYear: number, lines: readonly RestatementLine[], reason: string, reference: string, requestId: string) =>
      call("fs_propose_restatement", { p_company_id: companyId, p_period_year: periodYear, p_lines: lines, p_reason: reason, p_reference: reference, p_request_id: requestId }),
    decideRestatement: (restatementId: string, decision: "approved" | "rejected" | "withdrawn", reason: string, requestId: string) =>
      call("fs_decide_restatement", { p_restatement_id: restatementId, p_decision: decision, p_reason: reason, p_request_id: requestId }),
    approve: (companyId: string, periodYear: number, approve: boolean, reason: string, requestId: string) =>
      call("fs_approve_comparatives", { p_company_id: companyId, p_period_year: periodYear, p_approve: approve, p_reason: reason, p_request_id: requestId }),
    /** The first-period exception (20261017100000): a genuinely first reporting period, with relevant evidence. */
    declareFirstPeriod: (companyId: string, periodYear: number, reason: string, evidenceKind: FirstPeriodEvidenceKind, evidenceRef: string, evidenceDate: string) =>
      call("fs_declare_first_period", { p_company_id: companyId, p_period_year: periodYear, p_declare: true, p_reason: reason, p_evidence_kind: evidenceKind, p_evidence_ref: evidenceRef, p_evidence_date: evidenceDate }),
  };
}

/** The evidence kinds the server accepts for a first-period declaration (fs_declare_first_period). */
export const FIRST_PERIOD_EVIDENCE = {
  certificate_of_incorporation: "Certificate of incorporation",
  certificate_of_registration: "Certificate of registration",
  commencement_resolution: "Commencement resolution",
  regulatory_commencement_notice: "Regulator's commencement notice",
} as const;
export type FirstPeriodEvidenceKind = keyof typeof FIRST_PERIOD_EVIDENCE;

/** The server's refusals of a first-period declaration, in words. */
export const FIRST_PERIOD_OUTCOMES: Readonly<Record<string, string>> = {
  recorded: "The first-period declaration is recorded; no comparatives are required for this period.",
  unchanged: "A first-period declaration is already in force.",
  forbidden: "Only a member who approves certifications can declare a first reporting period.",
  feature_disabled: "Financial statements are not enabled for this company.",
  invalid_request: "A reason, the evidence reference and its issue date are required.",
  evidence_not_relevant: "That evidence does not establish a first reporting period.",
  evidence_date_in_future: "The evidence's issue date cannot be in the future.",
  no_period: "This reporting period is not set up for the company.",
  earlier_reviewed_period_exists: "An earlier period has a reviewed trial balance: this is not a first period. Import or review the prior year instead.",
  earlier_period_data_exists: "An earlier period has trial-balance data: this is not a first period. Import or review the prior year instead.",
};
