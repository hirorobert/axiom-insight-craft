/**
 * _shared/tbAuthority.ts — consumers use the authoritative trial balance or refuse (E2, gate W3).
 *
 * A function that reads an upload's processing result (tax computation, findings, comparatives, disclosure notes,
 * management letter) first asks the database whether THAT upload carries the period's authoritative certification:
 * get_authoritative_certification(company, period) — since S2 (20261008100000) authority is computed at read time (the
 * upload's current attempt completed, its source unchanged, its certification not invalidated, every input it used still at
 * the revision it used). Anything else — no authority, another upload, a legacy certification, a lookup error — is a
 * refusal (AUTHORITY_REQUIRED). Nothing is computed from a result that is not authoritative; there is no fallback.
 */

export type UploadAuthority =
  | { ok: true; certificationId: string }
  | { ok: false; code: "AUTHORITY_REQUIRED"; reason: "not_authoritative" | "other_upload" | "no_period" | "lookup_failed" };

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

export async function requireAuthoritativeUpload(
  rpc: Rpc,
  params: { companyId: string | null | undefined; periodYear: number | null | undefined; uploadId: string },
): Promise<UploadAuthority> {
  if (!params.companyId || typeof params.periodYear !== "number" || !Number.isInteger(params.periodYear)) {
    return { ok: false, code: "AUTHORITY_REQUIRED", reason: "no_period" };
  }
  const { data, error } = await rpc("get_authoritative_certification", { p_company_id: params.companyId, p_period_year: params.periodYear });
  if (error) return { ok: false, code: "AUTHORITY_REQUIRED", reason: "lookup_failed" };
  const row = (Array.isArray(data) ? data[0] : data) as { id?: unknown; upload_id?: unknown } | null | undefined;
  if (!row || typeof row.id !== "string") return { ok: false, code: "AUTHORITY_REQUIRED", reason: "not_authoritative" };
  if (row.upload_id !== params.uploadId) return { ok: false, code: "AUTHORITY_REQUIRED", reason: "other_upload" };
  return { ok: true, certificationId: row.id };
}

/** The customer-facing refusal body (no internal engine names). */
export const AUTHORITY_REQUIRED_BODY = Object.freeze({
  error: "AUTHORITY_REQUIRED",
  code: "AUTHORITY_REQUIRED",
  message: "This trial balance has no current reviewed result. Check it again in Trial balance review before using it here.",
});

export function authorityRefusal(corsHeaders: Record<string, string>, refusal: Extract<UploadAuthority, { ok: false }>): Response {
  return new Response(JSON.stringify({ ...AUTHORITY_REQUIRED_BODY, reason: refusal.reason }), {
    status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
