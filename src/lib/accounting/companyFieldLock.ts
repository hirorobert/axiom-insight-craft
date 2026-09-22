/**
 * companyFieldLock — the period/framework contract for company-level fields that already have
 * processed trial balance data behind them (`companies.reporting_framework`, `companies.fiscal_year_end`).
 *
 * Pure. No DB access — the caller supplies whether ANY upload for the company has ever been
 * processed (`trial_balance_uploads.processed_at IS NOT NULL`).
 *
 * Contract:
 *   - Editable freely before anything has been processed (pure setup, no risk of reinterpreting
 *     work that does not exist yet).
 *   - Once something has processed, the field locks — CompanyManager.tsx never lets a plain form
 *     save silently change a value that already governs processed statements/tax output.
 *   - A locked field can still be corrected, but only through an explicit, reasoned, audited
 *     action (CompanyManager's "Correct instead" flow) — this IS the "atomic audited mutation":
 *     no separate restatement-engagement feature is invented, the existing audit_logs table
 *     (via useAuditLog, already the approved write path for company edits) records the old value,
 *     the new value and the reason in one atomic update + log call.
 */

export interface CompanyFieldLockInput {
  hasProcessedUpload: boolean;
}

export interface CompanyFieldLockResult {
  locked: boolean;
  reason: string | null;
}

const LOCK_REASON =
  "Trial balance data has already been processed under this value. Changing it here would silently reinterpret work that is already done.";

export function deriveCompanyFieldLock(input: CompanyFieldLockInput): CompanyFieldLockResult {
  if (!input.hasProcessedUpload) {
    return { locked: false, reason: null };
  }
  return { locked: true, reason: LOCK_REASON };
}

export interface FieldChangeGuardInput {
  locked: boolean;
  frameworkChanged: boolean;
  frameworkCorrectionReason: string | null;
  fiscalYearEndChanged: boolean;
  fiscalYearEndCorrectionReason: string | null;
}

export type CompanyLockedField = "reporting_framework" | "fiscal_year_end";

export interface FieldChangeGuardResult {
  allowed: boolean;
  blockedField: CompanyLockedField | null;
}

/**
 * The actual enforcement behind the "Correct instead" affordance: a save may only carry a changed
 * value for a locked field alongside its own recorded correction reason. A disabled <Select> is the
 * UI's first line of defence; this is the one that still holds if that were ever bypassed.
 */
export function guardCompanyFieldChange(input: FieldChangeGuardInput): FieldChangeGuardResult {
  if (input.locked) {
    if (input.frameworkChanged && !input.frameworkCorrectionReason) {
      return { allowed: false, blockedField: "reporting_framework" };
    }
    if (input.fiscalYearEndChanged && !input.fiscalYearEndCorrectionReason) {
      return { allowed: false, blockedField: "fiscal_year_end" };
    }
  }
  return { allowed: true, blockedField: null };
}
