/**
 * companyFieldLock — the period/framework contract for company-level fields that already have
 * processed trial balance data behind them (`companies.reporting_framework`, `companies.fiscal_year_end`).
 *
 * Pure. No DB access — the caller supplies the PROCESSING CERTAINTY for the company
 * (trial_balance_uploads.processed_at IS NOT NULL, for any upload).
 *
 * Contract (absolute — no reason, override, or escape hatch of any kind):
 *   - Editable freely ONLY when positively confirmed that nothing has ever processed.
 *   - The instant anything has processed — or the read is still in flight, or the read failed, or
 *     the read result is in any way uncertain — the field is immutable. An audit log entry does not
 *     preserve financial consistency, so no amount of explanation ever reopens it. There is no
 *     "Correct instead" mutation path anymore: CompanyManager.tsx offers "Start corrected
 *     engagement" instead, which creates a new engagement through the existing authoritative
 *     creation path (open_engagement_with_scope) and never writes to this company's own
 *     reporting_framework/fiscal_year_end row.
 *   - Fails CLOSED on uncertainty: "checking" and "check_failed" are both LOCKED, exactly like
 *     "processed". Only the single positive state "not_processed" unlocks the field. A transient
 *     read failure must never be mistaken for "nothing has processed yet".
 */

export type ProcessingCertainty = "checking" | "processed" | "not_processed" | "check_failed";

export interface CompanyFieldLockInput {
  processingCertainty: ProcessingCertainty;
}

export interface CompanyFieldLockResult {
  locked: boolean;
  reason: string | null;
}

const LOCK_REASONS: Record<Exclude<ProcessingCertainty, "not_processed">, string> = {
  processed:
    "Trial balance data has already been processed under this value. It cannot be changed here — start a corrected engagement instead.",
  checking: "Checking whether this company has processed data — locked until that is confirmed.",
  check_failed:
    "Could not confirm whether this company has processed data. Locked until this can be verified — a connection problem is never treated as \"nothing has processed yet\".",
};

export function deriveCompanyFieldLock(input: CompanyFieldLockInput): CompanyFieldLockResult {
  if (input.processingCertainty === "not_processed") {
    return { locked: false, reason: null };
  }
  return { locked: true, reason: LOCK_REASONS[input.processingCertainty] };
}

/**
 * The reporting framework's own lock. A framework that has been DECIDED follows deriveCompanyFieldLock exactly (locked
 * once anything has processed, and while that is uncertain). A company whose framework has never been decided (NULL)
 * may record its FIRST decision whatever its processing state: there is no value that data was processed under, the
 * server (set_company_reporting_framework, 20261127100000) permits exactly this first decision, records it, refuses it
 * while a check is running, and the decision makes any earlier certification non-authoritative (the #framework
 * dependency) so the trial balance is checked again under it. Changing a decided framework is never reopened here.
 */
export function deriveFrameworkFieldLock(input: { current: string | null | undefined } & CompanyFieldLockInput): CompanyFieldLockResult {
  if (input.current === null || input.current === undefined) return { locked: false, reason: null };
  return deriveCompanyFieldLock(input);
}

export type CompanyLockedField = "reporting_framework" | "fiscal_year_end";

export interface FieldChangeGuardInput {
  locked: boolean;
  /** The framework's own lock (deriveFrameworkFieldLock); defaults to `locked`. */
  frameworkLocked?: boolean;
  frameworkChanged: boolean;
  fiscalYearEndChanged: boolean;
}

export interface FieldChangeGuardResult {
  allowed: boolean;
  blockedField: CompanyLockedField | null;
}

/**
 * The actual enforcement behind the locked fields: a save may NEVER carry a changed value for a
 * locked field, under any circumstance. There is deliberately no "reason" parameter of any kind —
 * that is the entire point of this hardening: a reason cannot override immutability because the
 * function has no input through which one could be supplied. A disabled <Select> is the UI's first
 * line of defence; this is the one that still holds if that were ever bypassed (a direct handler
 * invocation, a devtools edit, a future refactor that forgets to check `disabled`).
 */
export function guardCompanyFieldChange(input: FieldChangeGuardInput): FieldChangeGuardResult {
  const frameworkLocked = typeof input.frameworkLocked === "boolean" ? input.frameworkLocked : input.locked;
  if (frameworkLocked && input.frameworkChanged) return { allowed: false, blockedField: "reporting_framework" };
  if (input.locked && input.fiscalYearEndChanged) return { allowed: false, blockedField: "fiscal_year_end" };
  return { allowed: true, blockedField: null };
}
