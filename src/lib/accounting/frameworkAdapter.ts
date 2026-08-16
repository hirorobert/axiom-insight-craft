/**
 * frameworkAdapter.ts — pure mapping between the CANONICAL DB representation
 * of reporting framework (`companies.reporting_framework`) and the Ω∞
 * EntityAccountingContext's orthogonal reportingFramework/accountingBasis
 * pair (C7: do not conflate the two concepts, even though the DB column
 * currently does for the IPSAS values).
 *
 * Canonical-source decision (2026-08-10, confirmed with project owner):
 * `companies.reporting_framework` is the source of truth going forward.
 * `fiscal_periods.accounting_basis` is a separate, inconsistent legacy enum
 * (PHASE-0 audit §2, §13) — do not write new logic against it; it is not
 * read or written by this adapter.
 *
 * This module does no Supabase I/O — it only converts typed <-> string so
 * every caller (detection logic, UI, edge functions) stays pure and testable.
 */

import type { AccountingBasis, ReportingFramework } from "./entityContext";

/** The exact CHECK-constrained values of companies.reporting_framework. */
export type CompanyReportingFrameworkDbValue =
  | "ifrs_for_smes"
  | "full_ifrs"
  | "ipsas_accrual"
  | "ipsas_cash";

export interface FrameworkBasisPair {
  framework: ReportingFramework;
  accountingBasis: AccountingBasis;
}

const DB_TO_CONTEXT: Record<CompanyReportingFrameworkDbValue, FrameworkBasisPair> = {
  ifrs_for_smes: { framework: "IFRS_FOR_SMES", accountingBasis: "ACCRUAL" },
  full_ifrs: { framework: "IFRS", accountingBasis: "ACCRUAL" },
  ipsas_accrual: { framework: "IPSAS_ACCRUAL", accountingBasis: "ACCRUAL" },
  // ipsas_cash has no dedicated ReportingFramework value yet — see the note
  // in entityContext.ts. Mapped to OTHER_CONFIRMED + CASH rather than
  // inventing an IPSAS_CASH framework value unilaterally; it is currently
  // unselectable in CompanyManager.tsx ("coming soon"), so this path is
  // untested against live data by design. Revisit when IPSAS cash-basis
  // presentation is actually specified (directive Section IX only covers
  // IPSAS accrual profiles).
  ipsas_cash: { framework: "OTHER_CONFIRMED", accountingBasis: "CASH" },
};

/**
 * Convert the canonical DB string value to the typed (framework, basis)
 * pair. Returns null for any value outside the known CHECK constraint —
 * callers must treat that as UNKNOWN and surface it, never guess (C4).
 */
export function fromCompanyReportingFrameworkDbValue(
  dbValue: string | null | undefined,
): FrameworkBasisPair | null {
  if (!dbValue) return null;
  return DB_TO_CONTEXT[dbValue as CompanyReportingFrameworkDbValue] ?? null;
}

/**
 * Convert a typed (framework, basis) pair back to the canonical DB string —
 * for the one write path that targets companies.reporting_framework today
 * (CompanyManager.tsx). Returns null when there is no lossless DB
 * representation of the pair (e.g. framework=IFRS + basis=CASH) — callers
 * must not write a guessed fallback (C4); surface the gap instead.
 */
export function toCompanyReportingFrameworkDbValue(
  framework: ReportingFramework,
  accountingBasis: AccountingBasis,
): CompanyReportingFrameworkDbValue | null {
  for (const [dbValue, pair] of Object.entries(DB_TO_CONTEXT) as Array<
    [CompanyReportingFrameworkDbValue, FrameworkBasisPair]
  >) {
    if (pair.framework === framework && pair.accountingBasis === accountingBasis) {
      return dbValue;
    }
  }
  return null;
}
