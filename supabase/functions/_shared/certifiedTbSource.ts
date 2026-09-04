/**
 * _shared/certifiedTbSource.ts — Ω∞ Production Closure.
 *
 * Single read-only access path from MAONO (analytical / advisory) to the
 * EXISTING authoritative accounting sources. Created to remove MAONO's
 * legacy dependency on `public.account_classifications`, a table that has
 * no migration anywhere in this repository and does not exist in the live
 * database (DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001).
 *
 * AUTHORITY MODEL (precedence, highest first) — no new authority is created
 * here, nothing in this module ever writes:
 *
 *   1. SAFISHA CertifiedTB — `get_authoritative_certification(company, year)`
 *      → `tb_certifications.rows_snapshot`. This is the immutable, hash-bound
 *      per-account certified trial balance: account code/name, accounting
 *      nature, sub-nature (the `account_classification` value that the
 *      professional review chain produced), debit/credit/net balance and the
 *      evidence tier. It is the ONLY source of per-account certified balances
 *      and per-account classification semantics in this system.
 *
 *   2. Professional tri-state authority — `account_mappings.is_cash_account`
 *      (Phase 6: NULL = no professional decision, never false). Used only to
 *      resolve the cash perimeter. An undecided flag is UNKNOWN and must
 *      fail closed at the caller; it is never coerced to "not cash".
 *
 *   3. `account_pl_mapping` — the existing company-scoped/global P&L category
 *      rule set (unchanged, resolved by the caller).
 *
 * Anything not obtainable from the above is UNKNOWN / CANNOT_ASSESS. Absence
 * is never converted to 0, false, or NOT_APPLICABLE.
 */

export type SourceLoad<T> =
  | { state: "KNOWN"; value: T }
  | { state: "CANNOT_ASSESS"; reason: string };

export interface CertifiedTbRow {
  accountCode: string | null;
  accountName: string;
  /** "asset" | "liability" | "equity" | "income" | "expense" — certified accounting nature. */
  nature: string;
  /** The certified `account_classification` value (e.g. "current_assets"). */
  subNature: string;
  debitBalance: number;
  creditBalance: number;
  netBalance: number;
  evidenceTier: number | null;
  requiresReview: boolean;
}

export interface CertifiedTb {
  certificationId: string;
  uploadId: string;
  periodYear: number | null;
  sourceFileHash: string | null;
  certifiedAt: string | null;
  requiresReview: boolean;
  rows: CertifiedTbRow[];
}

/** Minimal structural shape of the Supabase client calls this module makes. */
export interface CertifiedTbClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalises one `tb_certifications.rows_snapshot` element. Returns null when
 * the row cannot be read as a certified account row — a malformed row is
 * UNKNOWN, never a zero-balance account.
 */
export function normalizeCertifiedRow(raw: unknown): CertifiedTbRow | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.accountName === "string" ? r.accountName : null;
  const debit = finiteNumber(r.debitBalance);
  const credit = finiteNumber(r.creditBalance);
  const net = finiteNumber(r.netBalance);
  if (name === null || debit === null || credit === null) return null;
  const nature = typeof r.nature === "string" ? r.nature : null;
  const subNature = typeof r.subNature === "string" ? r.subNature : null;
  if (nature === null || subNature === null) return null;
  return {
    accountCode: typeof r.accountCode === "string" && r.accountCode.trim() !== "" ? r.accountCode : null,
    accountName: name,
    nature,
    subNature,
    debitBalance: debit,
    creditBalance: credit,
    netBalance: net ?? debit - credit,
    evidenceTier: finiteNumber(r.evidenceTier),
    requiresReview: r.requiresReview === true,
  };
}

/**
 * Pure interpretation of a `get_authoritative_certification` result row.
 * Kept separate from I/O so it is directly unit-testable.
 */
export function interpretCertification(row: unknown): SourceLoad<CertifiedTb> {
  if (row === null || row === undefined || typeof row !== "object") {
    return {
      state: "CANNOT_ASSESS",
      reason: "No authoritative SAFISHA certification exists for this company and period.",
    };
  }
  const c = row as Record<string, unknown>;
  if (c.is_blocking === true) {
    return {
      state: "CANNOT_ASSESS",
      reason: "The authoritative SAFISHA certification for this period is blocking — no certified balances exist.",
    };
  }
  const snapshot = c.rows_snapshot;
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return {
      state: "CANNOT_ASSESS",
      reason: "The authoritative SAFISHA certification carries no certified account rows.",
    };
  }
  const rows: CertifiedTbRow[] = [];
  for (const raw of snapshot) {
    const norm = normalizeCertifiedRow(raw);
    if (norm === null) {
      return {
        state: "CANNOT_ASSESS",
        reason: "The certified trial balance contains a row that cannot be read — balances are not assessable.",
      };
    }
    rows.push(norm);
  }
  return {
    state: "KNOWN",
    value: {
      certificationId: typeof c.id === "string" ? c.id : "",
      uploadId: typeof c.upload_id === "string" ? c.upload_id : "",
      periodYear: finiteNumber(c.period_year),
      sourceFileHash: typeof c.source_file_hash === "string" ? c.source_file_hash : null,
      certifiedAt: typeof c.certified_at === "string" ? c.certified_at : null,
      requiresReview: c.requires_review === true,
      rows,
    },
  };
}

/** Reads the authoritative CertifiedTB for a company/period. Never writes. */
export async function loadCertifiedTb(
  client: CertifiedTbClient,
  companyId: string,
  periodYear: number,
): Promise<SourceLoad<CertifiedTb>> {
  const { data, error } = await client.rpc("get_authoritative_certification", {
    p_company_id: companyId,
    p_period_year: periodYear,
  });
  if (error) {
    return {
      state: "CANNOT_ASSESS",
      reason: `Authoritative certification could not be read: ${String(error.message).slice(0, 180)}`,
    };
  }
  const first = Array.isArray(data) ? data[0] : data;
  return interpretCertification(first ?? null);
}

// ── Professional cash perimeter (tri-state, Phase 6) ─────────────────────────

export type CashState = "CASH" | "NOT_CASH" | "UNKNOWN";

export interface CashPerimeter {
  /** account_key (code, else normalized name) → explicit professional decision. */
  decided: Map<string, boolean>;
}

/** Same key law as `account_mappings.account_key`: code when present, else normalized name. */
export function certifiedRowKey(row: { accountCode: string | null; accountName: string }): string {
  const code = (row.accountCode ?? "").trim();
  if (code !== "") return code;
  return row.accountName.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

export function resolveCashState(perimeter: CashPerimeter, key: string): CashState {
  const decided = perimeter.decided.get(key);
  if (decided === undefined) return "UNKNOWN";
  return decided ? "CASH" : "NOT_CASH";
}

/**
 * Reads the professional cash perimeter. Only explicit true/false decisions
 * are recorded; a NULL flag (no professional decision) is deliberately absent
 * from the map so callers resolve it as UNKNOWN and fail closed.
 */
export async function loadCashPerimeter(
  client: CertifiedTbClient,
  companyId: string,
): Promise<SourceLoad<CashPerimeter>> {
  const { data, error } = await client
    .from("account_mappings")
    .select("account_key, is_cash_account")
    .eq("company_id", companyId);
  if (error) {
    return {
      state: "CANNOT_ASSESS",
      reason: `Professional cash perimeter could not be read: ${String(error.message).slice(0, 180)}`,
    };
  }
  const decided = new Map<string, boolean>();
  for (const raw of (Array.isArray(data) ? data : [])) {
    const r = raw as Record<string, unknown>;
    const key = typeof r.account_key === "string" ? r.account_key : null;
    if (key === null) continue;
    if (r.is_cash_account === true) decided.set(key, true);
    else if (r.is_cash_account === false) decided.set(key, false);
    // null/undefined => no professional decision => intentionally omitted
  }
  return { state: "KNOWN", value: { decided } };
}

// ── UNKNOWN-safe aggregation ─────────────────────────────────────────────────

/**
 * Sums components where EVERY component must be known for the total to be
 * claimed. One unknown component makes the aggregate unknown — an aggregate
 * never silently drops a missing part, and never treats it as zero.
 */
export function sumRequiringAll(components: Array<number | null>): number | null {
  let total = 0;
  for (const c of components) {
    if (c === null || !Number.isFinite(c)) return null;
    total += c;
  }
  return Number.isFinite(total) ? total : null;
}
