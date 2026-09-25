// Official Reporting Pack sealing — the server hashes the exact bytes (security correction B-4, 20260925140000).
//
// A browser-supplied hash can never make a file official. The client uploads the exact bytes it built for an issuance;
// this handler:
//   1. validates the binding fields and the file type for the pack kind, and the size;
//   2. computes the SHA-256 of the RECEIVED bytes itself (no client hash is read at all);
//   3. stores the bytes in the private reporting-packs bucket at <company>/<issuance>.<ext> without overwrite;
//   4. seals the issuance with seal_reporting_pack_server (service role only, user id from the verified JWT), which
//      re-checks the user, workspace, period, output reference, format, expiry, entitlement and capability;
//   5. removes the stored object again if the seal is refused (nothing official remains).
// verifyStoredPack re-hashes the stored object of a sealed issuance, so a substituted object is detected.
// Pure except for the injected dependencies; unit-tested in Node (src/lib/commercial/reportingPackSeal.test.ts).

export const PACK_FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  financial_statements_pdf: ["pdf"],
  financial_statements_spreadsheet: ["xlsx"],
  financial_statements_data: ["json", "csv"],
  filing_pack: ["xml", "zip", "json"],
  client_pack: ["pdf", "zip"],
  board_pack: ["xlsx"],
  management_letter: ["pdf"],
  disclosure_notes: ["pdf"],
  tax_computation: ["pdf"],
  tax_workpaper: ["csv", "txt", "xlsx"],
};
export const MAX_PACK_BYTES = 50 * 1024 * 1024;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", json: "application/json",
  csv: "text/csv", txt: "text/plain", xml: "application/xml", zip: "application/zip",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
export interface SealDeps {
  readonly rpc: Rpc;
  /** Store without overwrite; an existing object is an error. */
  readonly put: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: unknown }>;
  readonly remove: (path: string) => Promise<unknown>;
  readonly get: (path: string) => Promise<Uint8Array | null>;
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>;
}
export interface SealInput {
  readonly userId: string;
  readonly issuanceId: string;
  readonly companyId: string;
  readonly periodYear: number;
  readonly packKind: string;
  readonly outputRef: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}
export interface SealResult {
  readonly httpStatus: number;
  readonly body: { readonly outcome: string; readonly content_sha256?: string; readonly issuance_id?: string };
}

const STATUS: Readonly<Record<string, number>> = {
  sealed: 200, invalid_request: 400, not_found: 404, binding_mismatch: 409, already_sealed: 409, expired: 410,
  entitlement_required: 402, capability_required: 403, workspace_access_denied: 403, unauthenticated: 401,
};

/** The file extension, when it is one this pack kind may be delivered as; otherwise null. */
export function packExtension(packKind: string, fileName: string): string | null {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(fileName ?? "")?.[1]?.toLowerCase() ?? "";
  return (PACK_FILE_TYPES[packKind] ?? []).includes(ext) ? ext : null;
}

export async function sealPack(deps: SealDeps, input: SealInput): Promise<SealResult> {
  const ext = packExtension(input.packKind, input.fileName);
  if (!UUID.test(input.userId ?? "") || !UUID.test(input.issuanceId ?? "") || !UUID.test(input.companyId ?? "")
      || !Number.isInteger(input.periodYear) || !ext || typeof input.outputRef !== "string"
      || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_PACK_BYTES) {
    return { httpStatus: 400, body: { outcome: "invalid_request" } };
  }
  const sha = await deps.sha256Hex(input.bytes);
  const path = `${input.companyId}/${input.issuanceId}.${ext}`;
  const stored = await deps.put(path, input.bytes, CONTENT_TYPES[ext]);
  if (stored.error) return { httpStatus: 409, body: { outcome: "already_sealed" } };
  const { data, error } = await deps.rpc("seal_reporting_pack_server", {
    p_user: input.userId, p_issuance_id: input.issuanceId, p_company_id: input.companyId, p_period_year: input.periodYear,
    p_pack_kind: input.packKind, p_output_ref: input.outputRef, p_content_sha256: sha, p_storage_path: path, p_byte_size: input.bytes.byteLength,
  });
  const outcome = !error && data && typeof data === "object" && typeof (data as { outcome?: unknown }).outcome === "string"
    ? (data as { outcome: string }).outcome : "seal_failed";
  if (outcome !== "sealed") {
    await deps.remove(path);
    return { httpStatus: STATUS[outcome] ?? 500, body: { outcome } };
  }
  return { httpStatus: 200, body: { outcome: "sealed", content_sha256: sha, issuance_id: input.issuanceId } };
}

/** Re-hashes the stored object of a sealed issuance: intact | substituted | missing | not_found. */
export async function verifyStoredPack(deps: SealDeps, issuanceId: string): Promise<{ readonly outcome: string; readonly company_id?: string }> {
  if (!UUID.test(issuanceId ?? "")) return { outcome: "not_found" };
  const { data, error } = await deps.rpc("reporting_pack_sealed_object", { p_issuance_id: issuanceId });
  const row = (!error && data && typeof data === "object" ? data : null) as { storage_path?: string; content_sha256?: string; company_id?: string } | null;
  if (!row?.storage_path || !row.content_sha256) return { outcome: "not_found" };
  const bytes = await deps.get(row.storage_path);
  if (!bytes) return { outcome: "missing", company_id: row.company_id };
  return { outcome: (await deps.sha256Hex(bytes)) === row.content_sha256 ? "intact" : "substituted", company_id: row.company_id };
}
