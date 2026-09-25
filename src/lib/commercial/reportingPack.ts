/**
 * Reporting Pack (REPORTING_PACK_EXPORT) on the client.
 *
 * A downloadable deliverable is rendered in the browser from data the user can already see, so no client check can
 * stop someone rebuilding a look-alike file. What the server makes authoritative is the OFFICIAL pack
 * (20260925120000): an issuance bound to the user, workspace, fiscal period, output / version and format, with a
 * short expiry, that is SEALED once by the SERVER: the exact bytes are uploaded to the seal-reporting-pack Edge Function,
 * which hashes what it received, stores it (private, no overwrite) and seals (entitlement and capability re-checked at
 * that moment; 20260925140000). A browser-computed hash is never sent or trusted. Nothing is saved unless the seal
 * succeeds; drafts (fs-draft references, prints, manual files) are never official.
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

/** Strict parse of the seal-reporting-pack answer; anything but "sealed" means the file must not be saved. */
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

/**
 * Uploads the exact bytes for the server to hash, store and seal (the seal-reporting-pack Edge Function). The server's
 * answer is the only seal; a transport error is a failure.
 */
export type SealUpload = (issuanceId: string, b: PackBinding, blob: Blob, fileName: string) => Promise<{ data: unknown; error: unknown }>;

export async function sealReportingPack(upload: SealUpload, issuanceId: string, b: PackBinding, blob: Blob, fileName: string): Promise<SealOutcome> {
  const { data, error } = await upload(issuanceId, b, blob, fileName);
  return error ? "failed" : parseSealOutcome(data);
}

/** The multipart body the Edge Function expects: the binding and the exact bytes, and never a hash. */
export function sealFormData(issuanceId: string, b: PackBinding, blob: Blob, fileName: string): FormData {
  const form = new FormData();
  form.set("issuance_id", issuanceId);
  form.set("company_id", b.companyId);
  form.set("period_year", String(b.periodYear));
  form.set("pack_kind", b.kind);
  form.set("output_ref", b.outputRef);
  form.set("file", blob, fileName);
  return form;
}

/**
 * The output reference of a financial-statements export: a saved version the server can check, or a named draft. A
 * draft reference is refused by the server's closed output-reference scheme: drafts are never official.
 */
export function financialStatementsOutputRef(lineage: { reportId: string; reportVersion: number | null; persisted: boolean; contentHash: string } | null): string | null {
  if (!lineage) return null;
  return lineage.persisted && lineage.reportVersion !== null
    ? `fs-report:${lineage.reportId}:v${lineage.reportVersion}`
    : `fs-draft:${lineage.reportId}:${lineage.contentHash.slice(0, 16)}`;
}

export type DeliveryOutcome = "delivered" | "locked" | "not_permitted" | "failed";

/**
 * The whole official path: issue → build the bytes (the issuance id may be printed in them) → upload them for the
 * SERVER to hash and seal → save. `save` runs ONLY after the server sealed the issuance for exactly these bytes.
 */
export type BuiltPack = Blob | { readonly blob: Blob; readonly fileName: string };

export async function deliverOfficialPack(
  rpc: Rpc, upload: SealUpload, b: PackBinding, build: (issuanceId: string) => BuiltPack | Promise<BuiltPack>,
  save: (blob: Blob, fileName: string | null) => void, fallbackFileName = "reporting-pack",
): Promise<DeliveryOutcome> {
  const issued = await issueReportingPack(rpc, b);
  if (issued.status !== "issued") return issued.status;
  const built = await build(issued.issuanceId);
  const blob = built instanceof Blob ? built : built.blob;
  const name = built instanceof Blob ? fallbackFileName : built.fileName;
  const sealed = await sealReportingPack(upload, issued.issuanceId, b, blob, name);
  if (sealed !== "sealed") return sealed;
  save(blob, built instanceof Blob ? null : built.fileName);
  return "delivered";
}
