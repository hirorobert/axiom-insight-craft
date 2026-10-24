/**
 * companyFramework — the ONE browser path to change a company's reporting framework (20261127100000).
 *
 * The server decides: set_company_reporting_framework checks the owner, refuses a change of an existing decision once any
 * certification or saved report exists, refuses while a check runs, and records an audited event. After 20261128100000 a
 * direct update of companies.reporting_framework is refused by the database, so this module is the only route that works.
 * Answers are read from structured fields (outcome / code / SQLSTATE), never from message text.
 */
import { FRAMEWORK_OPTIONS } from "@/lib/workspace/frameworkOptions";

export type ReportingFramework = "ifrs_for_smes" | "full_ifrs" | "ipsas_accrual" | "ipsas_cash";

export type FrameworkChangeResult =
  | { kind: "changed"; from: ReportingFramework | null; to: ReportingFramework; eventId: string }
  | { kind: "replayed"; from: ReportingFramework | null; to: ReportingFramework; eventId: string }
  | { kind: "unchanged"; framework: ReportingFramework }
  | { kind: "locked"; current: ReportingFramework | null }
  | { kind: "stale"; current: ReportingFramework | null }
  | { kind: "processing"; current: ReportingFramework | null }
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "error" };

export interface FrameworkChangeClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

const FRAMEWORKS: readonly ReportingFramework[] = ["ifrs_for_smes", "full_ifrs", "ipsas_accrual", "ipsas_cash"];
const asFramework = (v: unknown): ReportingFramework | null => (typeof v === "string" && (FRAMEWORKS as readonly string[]).includes(v) ? (v as ReportingFramework) : null);
const label = (v: ReportingFramework | null) => (v ? FRAMEWORK_OPTIONS.find((o) => o.value === v)?.label ?? v : "not selected");

/** The recorded reason: what changed and where. The audit event also records who and when. */
export function frameworkChangeReason(from: ReportingFramework | null, to: ReportingFramework): string {
  return `Reporting framework set in company settings: ${label(from)} -> ${label(to)}`.slice(0, 500);
}

/** Reads the server's answer strictly. Anything not in the contract is an error, never a success. */
export function parseFrameworkChange(data: unknown, error: { code?: string } | null): FrameworkChangeResult {
  if (error) {
    if (error.code === "42501") return { kind: "forbidden" };
    if (error.code === "22023") return { kind: "invalid" };
    return { kind: "error" };
  }
  if (!data || typeof data !== "object") return { kind: "error" };
  const d = data as Record<string, unknown>;
  const to = asFramework(d.to);
  const from = d.from === null ? null : asFramework(d.from);
  const eventId = typeof d.eventId === "string" ? d.eventId : null;
  switch (d.outcome) {
    case "changed":
    case "replayed":
      if (!to || !eventId || (d.from !== null && !from)) return { kind: "error" };
      return { kind: d.outcome, from, to, eventId };
    case "unchanged":
      return to ? { kind: "unchanged", framework: to } : { kind: "error" };
    case "refused": {
      const current = d.current === null ? null : asFramework(d.current);
      if (d.current !== null && !current) return { kind: "error" };
      if (d.code === "FRAMEWORK_LOCKED") return { kind: "locked", current };
      if (d.code === "STALE_FRAMEWORK") return { kind: "stale", current };
      if (d.code === "PROCESSING_IN_PROGRESS") return { kind: "processing", current };
      return { kind: "error" };
    }
    default:
      return { kind: "error" };
  }
}

export async function changeReportingFramework(
  client: FrameworkChangeClient,
  p: { companyId: string; from: ReportingFramework | null; to: ReportingFramework; requestId: string },
): Promise<FrameworkChangeResult> {
  try {
    const { data, error } = await client.rpc("set_company_reporting_framework", {
      p_company_id: p.companyId, p_framework: p.to, p_expected_framework: p.from,
      p_reason: frameworkChangeReason(p.from, p.to), p_request_id: p.requestId,
    });
    return parseFrameworkChange(data, error);
  } catch {
    return { kind: "error" };
  }
}

/** Words for a refusal; null for a success. */
export function frameworkChangeMessage(r: FrameworkChangeResult): string | null {
  switch (r.kind) {
    case "changed": case "replayed": case "unchanged": return null;
    case "locked": return "Reporting framework is locked because trial balance data or a saved report already exists. Start a corrected engagement instead.";
    case "stale": return "The reporting framework was changed elsewhere. Reload the company and decide again.";
    case "processing": return "A trial balance check is running for this company. Change the framework after it finishes.";
    case "forbidden": return "Only the company's owner can change its reporting framework.";
    case "invalid": return "Choose a supported reporting framework.";
    case "error": return "The reporting framework could not be changed. Nothing was saved; try again.";
  }
}
