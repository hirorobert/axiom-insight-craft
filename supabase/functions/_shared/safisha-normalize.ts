// Ω∞ Phase 0 — deterministic normalized-input canonicalization (SERVER,
// AUTHORITATIVE COPY).
//
// NORMALIZED_INPUT_HASH_V1 — mirrors src/lib/safisha/normalizedInputHash.ts
// exactly. This copy is authoritative for real certification; the browser
// copy exists only to make the algorithm provable via this project's
// vitest toolchain (no Deno runtime is executable in that environment).
//
// Reuses canonicalJson/sha256Hex from ./hash.ts unchanged — no third
// hashing implementation.
//
// DUPLICATE-KEY PROOF (not assumed): process-trial-balance sums
// totalDebits/totalCredits over every raw row via .reduce() with no
// deduplication (confirmed by direct read, Gate 1/Slice 1 assessment). Two
// rows sharing the same account_code and account_name but different
// debit/credit values are economically distinct today and MUST remain
// distinct here — this module never aggregates rows, only orders them
// deterministically.
//
// NOT executed/tested in this environment — no Deno runtime beyond `deno
// check` is available here.

import { canonicalJson, sha256Hex, type CanonicalValue } from "./hash.ts";

export interface NormalizedInputRow {
  accountCode: string | null;
  accountName: string;
  debit: number;
  credit: number;
}

/** Mirrors process-trial-balance's own normalizeAccountName exactly. */
function normalizeAccountNameForHash(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic total ordering over the full canonical tuple (account_code,
 * normalized_account_name, debit, credit). Rows sharing an identical tuple
 * are economically indistinguishable for hashing purposes — no further
 * tie-breaker is needed or included.
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
  return sha256Hex(canonicalJson(canonical as unknown as CanonicalValue));
}
