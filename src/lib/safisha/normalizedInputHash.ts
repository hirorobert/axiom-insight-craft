// Ω∞ Phase 0 — deterministic normalized-input canonicalization.
//
// NORMALIZED_INPUT_HASH_V1 — mirrors supabase/functions/_shared/safisha-normalize.ts
// exactly. The SERVER (Deno) copy is authoritative for real certification —
// this copy exists so the algorithm is provable via this project's vitest
// toolchain. If you change this logic, change it in both places and re-run
// tests in both suites, mirroring the existing canonicalHash.ts precedent.
//
// Reuses canonicalJson/sha256Hex from src/lib/shared/canonicalHash.ts
// unchanged — no third hashing implementation.
//
// DUPLICATE-KEY PROOF (not assumed): process-trial-balance sums
// totalDebits/totalCredits over every raw row via .reduce() with no
// deduplication (confirmed by direct read, Gate 1/Slice 1). Two rows
// sharing the same account_code and account_name but different debit/
// credit values are economically distinct today and MUST remain distinct
// here — this module never aggregates rows, only orders them
// deterministically.

import { canonicalJson, sha256Hex, type CanonicalValue } from "@/lib/shared/canonicalHash";
import type { NormalizedInputRow } from "./types";

/** Mirrors src/lib/normalizeAccountName.ts exactly — same known JS/SQL
 *  accent-stripping discrepancy applies here as everywhere else it's used;
 *  not re-litigated in this module. */
function normalizeAccountNameForHash(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic total ordering over the full canonical tuple
 * (account_code, normalized_account_name, debit, credit). Rows sharing an
 * identical tuple are economically indistinguishable for hashing purposes —
 * their relative order cannot affect the hash's semantic content, so no
 * further tie-breaker (e.g. source_row_number) is needed or included. This
 * is what makes the hash order-independent without collapsing genuinely
 * distinct rows: two rows with the same code+name but different debit/
 * credit sort to different, stable positions and remain separate array
 * elements.
 */
function compareRows(a: NormalizedInputRow, b: NormalizedInputRow): number {
  const codeA = a.accountCode ?? "";
  const codeB = b.accountCode ?? "";
  if (codeA !== codeB) return codeA < codeB ? -1 : 1;

  if (a.accountName !== b.accountName) return a.accountName < b.accountName ? -1 : 1;

  if (a.debit !== b.debit) return a.debit < b.debit ? -1 : 1;
  if (a.credit !== b.credit) return a.credit < b.credit ? -1 : 1;

  return 0;
}

/**
 * Produces the canonical, order-independent row list used to compute
 * normalized_input_hash. Account codes are trimmed; account names are
 * normalized via the same function the classifier itself uses for
 * matching — two rows differing only in casing/punctuation of the same
 * account name hash identically, which is correct: they represent the
 * same account.
 */
export function buildCanonicalRows(rows: NormalizedInputRow[]): NormalizedInputRow[] {
  const normalized = rows.map((r) => ({
    accountCode: r.accountCode?.trim() || null,
    accountName: normalizeAccountNameForHash(r.accountName),
    debit: r.debit,
    credit: r.credit,
  }));
  return normalized.sort(compareRows);
}

export async function computeNormalizedInputHash(rows: NormalizedInputRow[]): Promise<string> {
  const canonical = buildCanonicalRows(rows);
  // NormalizedInputRow's fields (string | null, string, number, number) are
  // all individually valid CanonicalValue members — this cast exists only
  // because TypeScript does not treat a named interface as satisfying an
  // index-signature type without one, not because of an actual runtime
  // shape mismatch. Narrow and local, not a workaround for missing types.
  return sha256Hex(canonicalJson(canonical as unknown as CanonicalValue));
}
