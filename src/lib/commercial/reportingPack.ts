/**
 * Reporting Pack (REPORTING_PACK_EXPORT) on the client.
 *
 * A downloadable deliverable is rendered in the browser from data the user can already see, so no client check can
 * stop someone rebuilding a look-alike file. What the server makes authoritative is the OFFICIAL pack
 * (20260925120000): an issuance bound to the user, workspace, fiscal period, output / version and format, with a
 * short expiry, that is SEALED once with the SHA-256 of the exact bytes produced (entitlement re-checked at that
 * moment) and can later be verified by that hash. Nothing is saved unless the seal succeeds.
 *
 * Covered: statement data (JSON / CSV), statement PDF and spreadsheet, board packs, management letters, disclosure
 * notes, tax computations and tax workpaper schedules (XBRL is gated server-side in generate-xbrl). Not deliverables
 * (never gated): the blank trial-balance template and exports of the user's own inputs (account mappings, uploads).
 * Free printing carries DRAFT_PRINT_MARK on every printed page.
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
  /** The person does not hold issue_reporting_pack in this workspace (a capability, never a job title). */
  | { readonly status: "not_permitted" }
  | { readonly status: "failed" };

/** Strict parse of issue_reporting_pack(); only a server "issued"/"already_issued" with an id may proceed. */
export function parseIssueOutcome(raw: unknown): IssueOutcome {
  if (!raw || typeof raw !== "object") return { status: "failed" };
  const r = raw as Record<string, unknown>;
  if ((r.outcome === "issued" || r.outcome === "already_issued") && typeof r.issuance_id === "string" && r.issuance_id.length > 0 && r.sealed !== true) {
    return { status: "issued", issuanceId: r.issuance_id };
  }
  if (r.outcome === "entitlement_required") return { status: "locked" };
  if (r.outcome === "capability_required") return { status: "not_permitted" };
  return { status: "failed" };
}

export type SealOutcome = "sealed" | "locked" | "not_permitted" | "failed";

/** Strict parse of consume_reporting_pack_issuance(); anything but "sealed" means the file must not be saved. */
export function parseSealOutcome(raw: unknown): SealOutcome {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>).outcome : null;
  if (o === "sealed") return "sealed";
  if (o === "entitlement_required" || o === "workspace_access_denied") return "locked";
  if (o === "capability_required") return "not_permitted";
  return "failed";
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** The bindings an issuance is made for, and checked against again when it is sealed. */
export interface PackBinding {
  readonly companyId: string;
  readonly periodYear: number;
  readonly kind: ReportingPackKind;
  /** The saved output / version the pack is for (e.g. "fs-report:<id>:v3", "upload:<id>"). */
  readonly outputRef: string;
}

/** Asks the server to issue one deliverable. A transport error is a failure, never an issuance. */
export async function issueReportingPack(rpc: Rpc, b: PackBinding, requestId: string = crypto.randomUUID()): Promise<IssueOutcome> {
  const { data, error } = await rpc("issue_reporting_pack", {
    p_company_id: b.companyId, p_period_year: b.periodYear, p_pack_kind: b.kind, p_output_ref: b.outputRef, p_request_id: requestId,
  });
  return error ? { status: "failed" } : parseIssueOutcome(data);
}

/** Seals the issuance with the SHA-256 of the exact bytes; the server re-checks every binding and the entitlement. */
export async function sealReportingPack(rpc: Rpc, issuanceId: string, b: PackBinding, sha256: string): Promise<SealOutcome> {
  const { data, error } = await rpc("consume_reporting_pack_issuance", {
    p_issuance_id: issuanceId, p_company_id: b.companyId, p_period_year: b.periodYear, p_pack_kind: b.kind,
    p_output_ref: b.outputRef, p_content_sha256: sha256,
  });
  return error ? "failed" : parseSealOutcome(data);
}

/** Lower-case hex SHA-256 of the bytes (Web Crypto). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The output reference of a financial-statements export: a saved version the server can check, or a named draft. */
export function financialStatementsOutputRef(lineage: { reportId: string; reportVersion: number | null; persisted: boolean; contentHash: string } | null): string | null {
  if (!lineage) return null;
  return lineage.persisted && lineage.reportVersion !== null
    ? `fs-report:${lineage.reportId}:v${lineage.reportVersion}`
    : `fs-draft:${lineage.reportId}:${lineage.contentHash.slice(0, 16)}`;
}

export type DeliveryOutcome = "delivered" | "locked" | "not_permitted" | "failed";

/**
 * The whole official path, independent of the browser: issue → build the bytes (the issuance id may be printed in
 * them) → hash → seal → save. `save` runs ONLY after the server sealed the issuance for exactly these bytes.
 */
export type BuiltPack = Blob | { readonly blob: Blob; readonly fileName: string };

export async function deliverOfficialPack(
  rpc: Rpc, b: PackBinding, build: (issuanceId: string) => BuiltPack | Promise<BuiltPack>, save: (blob: Blob, fileName: string | null) => void,
): Promise<DeliveryOutcome> {
  const issued = await issueReportingPack(rpc, b);
  if (issued.status !== "issued") return issued.status;
  const built = await build(issued.issuanceId);
  const blob = built instanceof Blob ? built : built.blob;
  const sealed = await sealReportingPack(rpc, issued.issuanceId, b, await sha256Hex(await blob.arrayBuffer()));
  if (sealed !== "sealed") return sealed;
  save(blob, built instanceof Blob ? null : built.fileName);
  return "delivered";
}
