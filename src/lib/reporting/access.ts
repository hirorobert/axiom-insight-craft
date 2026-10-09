// reporting/access.ts — whether this company may use the reporting workbench, as the SERVER decides it. Pure.
//
// The answer comes from financial_statements_workspace_access(company): an accepted membership, the kill switch off and
// the company on the financial-statements rollout allow-list. Reporting is offered per company, not to every customer:
// anything other than an explicit "enabled" — an error, an unknown payload, a missing answer — is disabled (fail closed).

export type ReportingAccess =
  | { readonly state: "loading" }
  | { readonly state: "enabled"; readonly role: string | null }
  | { readonly state: "disabled"; readonly reason: string };

/** The two workbench groups that exist only for a company with reporting access. */
export const REPORTING_GROUP_IDS: ReadonlySet<string> = new Set(["financial-statements", "signoff-exports"]);

export function parseReportingAccess(raw: unknown): ReportingAccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "disabled", reason: "UNKNOWN" };
  const r = raw as Record<string, unknown>;
  if (r.enabled === true) return { state: "enabled", role: typeof r.role === "string" ? r.role : null };
  return { state: "disabled", reason: typeof r.reason === "string" ? r.reason : "UNKNOWN" };
}
