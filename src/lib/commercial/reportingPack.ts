/**
 * Reporting Pack (REPORTING_PACK_EXPORT) on the client: every downloadable reporting deliverable — statement data
 * (JSON / CSV), statement PDF and spreadsheet, XBRL, board packs, management letters, disclosure notes, tax
 * computations and tax workpaper schedules — is issued by the server first (issue_reporting_pack, 20260925100000).
 * Nothing is generated or downloaded unless the server answers "issued" (or "already_issued" for a retry). Free
 * workspaces keep the in-app preview; anything they print carries DRAFT_PRINT_MARK on every printed page.
 *
 * Not reporting deliverables (never gated): the blank trial-balance template and exports of the user's own inputs
 * (their account-mapping configuration, their upload list).
 */
export const REPORTING_PACK_KINDS = [
  "financial_statements_pdf",
  "financial_statements_spreadsheet",
  "financial_statements_data",
  "filing_pack",
  "client_pack",
  "board_pack",
  "management_letter",
  "disclosure_notes",
  "tax_computation",
  "tax_workpaper",
] as const;
export type ReportingPackKind = (typeof REPORTING_PACK_KINDS)[number];

/** The marking every free (not entitled) printed page carries. */
export const DRAFT_PRINT_MARK = "DRAFT — NOT CERTIFIED — NOT FOR FILING OR CLIENT ISSUE";

export type IssueOutcome =
  | { readonly status: "issued"; readonly issuanceId: string }
  | { readonly status: "locked" }
  | { readonly status: "failed" };

/** Strict parse of issue_reporting_pack(); only a server "issued"/"already_issued" with an id allows a download. */
export function parseIssueOutcome(raw: unknown): IssueOutcome {
  if (!raw || typeof raw !== "object") return { status: "failed" };
  const r = raw as Record<string, unknown>;
  if ((r.outcome === "issued" || r.outcome === "already_issued") && typeof r.issuance_id === "string" && r.issuance_id.length > 0) {
    return { status: "issued", issuanceId: r.issuance_id };
  }
  if (r.outcome === "entitlement_required") return { status: "locked" };
  return { status: "failed" };
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** Asks the server to issue one deliverable. A transport error is a failure, never an issuance. */
export async function issueReportingPack(
  rpc: Rpc, companyId: string, periodYear: number, kind: ReportingPackKind, requestId: string = crypto.randomUUID(),
): Promise<IssueOutcome> {
  const { data, error } = await rpc("issue_reporting_pack", { p_company_id: companyId, p_period_year: periodYear, p_pack_kind: kind, p_request_id: requestId });
  return error ? { status: "failed" } : parseIssueOutcome(data);
}
