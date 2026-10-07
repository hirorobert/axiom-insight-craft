/**
 * _shared/treatmentRequest.ts — the treatment request identity (20261007100000, H1b).
 *
 * When the engine flags an account that needs a treatment decision (rule "closing_stock_credit", version 1: a reviewed
 * current-asset credit matching closing-stock patterns), it emits a request binding the decision to everything it depends
 * on: rule id and version, company, upload, the upload's source file hash, the account key and code, the account's debit
 * and credit in minor units (decimal strings), and the mapping's review_decision_id.
 *
 * request_id = SHA-256 (hex) of the canonical text below. public.treatment_request_id(jsonb) builds the IDENTICAL bytes
 * (scripts/db-proof/h1Authority.mjs proves equality on real PostgreSQL). Any change to any field gives a different id, so a
 * recorded confirmation applies only to the exact facts it was given for — it expires on its own.
 */

export const TREATMENT_REQUEST_CONTRACT = "tb-treatment/1";
export const CLOSING_STOCK_RULE = { rule_id: "closing_stock_credit", rule_version: "1" } as const;

export interface TreatmentRequestFacts {
  rule_id: string;
  rule_version: string;
  company_id: string;
  upload_id: string;
  source_file_hash: string;
  account_key: string;
  account_code: string | null;
  debit_minor: string;
  credit_minor: string;
  mapping_decision_id: string;
}

export interface TreatmentRequest extends TreatmentRequestFacts {
  request_id: string;
}

const MINOR = /^(0|-?[1-9][0-9]*)$/;

/** The canonical text; a missing field is an empty segment (exactly as the SQL function). */
export function canonicalTreatmentText(f: TreatmentRequestFacts): string {
  return [TREATMENT_REQUEST_CONTRACT, f.rule_id, f.rule_version, f.company_id, f.upload_id, f.source_file_hash,
    f.account_key, f.account_code ?? "", f.debit_minor, f.credit_minor, f.mapping_decision_id].join("|");
}

export async function treatmentRequestId(f: TreatmentRequestFacts): Promise<string> {
  if (!MINOR.test(f.debit_minor) || !MINOR.test(f.credit_minor)) throw new Error("treatment request: amounts must be canonical minor-unit strings");
  const bytes = new TextEncoder().encode(canonicalTreatmentText(f));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildTreatmentRequest(f: TreatmentRequestFacts): Promise<TreatmentRequest> {
  return { ...f, request_id: await treatmentRequestId(f) };
}
