// financialStatementsWorkspace/comparativeSource.ts — resolves the
// comparative-period source for a workspace from the company's own uploads.
// Pure and deterministic. A comparative is a prior-year trial balance of the
// SAME company that is complete and valid; anything else is reported as a
// specific missing/ineligible state, never silently ignored and never
// substituted with another period.

export const COMPARATIVE_PERIOD_ID = "COMPARATIVE_1";

export interface ComparativeCandidateUpload {
  readonly id: string;
  readonly company_id: string | null;
  readonly period_year?: number | null;
  readonly status: string;
  readonly is_valid: boolean | null;
  readonly processing_result: unknown;
  readonly uploaded_at: string;
}

export type ComparativeSourceState<T extends ComparativeCandidateUpload> =
  | { readonly state: "AVAILABLE"; readonly upload: T; readonly periodYear: number }
  | { readonly state: "MISSING"; readonly periodYear: number; readonly reason: string }
  | { readonly state: "INELIGIBLE"; readonly periodYear: number; readonly upload: T; readonly reason: string };

export function resolveComparativeSource<T extends ComparativeCandidateUpload>(uploads: readonly T[], companyId: string, currentPeriodYear: number): ComparativeSourceState<T> {
  const priorYear = currentPeriodYear - 1;
  const candidates = uploads
    .filter((u) => u.company_id === companyId && u.period_year === priorYear)
    // Most recent upload for that exact prior year wins; id breaks ties deterministically.
    .sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : a.uploaded_at > b.uploaded_at ? -1 : a.id.localeCompare(b.id)));

  if (candidates.length === 0) {
    return { state: "MISSING", periodYear: priorYear, reason: `No trial balance has been imported for ${priorYear}.` };
  }
  const eligible = candidates.find((u) => u.status === "complete" && u.is_valid === true && u.processing_result != null);
  if (eligible) return { state: "AVAILABLE", upload: eligible, periodYear: priorYear };
  const latest = candidates[0];
  return {
    state: "INELIGIBLE",
    periodYear: priorYear,
    upload: latest,
    reason: `The ${priorYear} trial balance is not complete and valid yet (status "${latest.status}"${latest.is_valid === false ? ", validation failed" : latest.is_valid === null ? ", not yet validated" : ""}).`,
  };
}
