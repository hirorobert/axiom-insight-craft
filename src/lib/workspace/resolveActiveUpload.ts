/**
 * resolveActiveUpload — pure, deterministic resolution of the "active" trial
 * balance for a workspace route, plus the canonical route builder used when a
 * user clicks a trial balance in the uploads ledger.
 *
 * Invariant (regression-tested): clicking a trial balance ALWAYS resolves to
 * that exact upload. A pinned ?upload=<id> wins over every heuristic, so a row
 * can never silently "disappear" from the certification ledger flow.
 */

export interface ResolvableUpload {
  id: string;
  period_year?: number | null;
  /** 20260923100000 upload lifecycle. Absent on rows read before the migration was applied. */
  lifecycle_state?: string | null;
}

/**
 * Lifecycle states that can be "the current upload". Retired, superseded and discard_pending rows are
 * history, so automatic resolution never lands on them (the database's uq_one_active_upload_per_period
 * holds exactly one row in these states per company/period). A row without lifecycle_state predates the
 * migration and stays eligible.
 */
const ACTIVE_LIFECYCLE_STATES = new Set(["active_unprocessed", "active_processing", "active_processed", "blocked"]);
export function isActiveLifecycle(upload: ResolvableUpload): boolean {
  return !upload.lifecycle_state || ACTIVE_LIFECYCLE_STATES.has(upload.lifecycle_state);
}

/**
 * Whether this upload may be processed again (Retry, Save & reprocess). Stricter than isActiveLifecycle: a missing or
 * unknown lifecycle_state fails closed. Retired, superseded, discarded and discard_pending uploads are history — the
 * engine refuses them with 409 and the database refuses the writes (20260923140000, PR #32 F-01).
 */
export function canReprocessUpload(upload: { lifecycle_state?: string | null } | null | undefined): boolean {
  return !!upload?.lifecycle_state && ACTIVE_LIFECYCLE_STATES.has(upload.lifecycle_state);
}

export interface ResolveActiveUploadArgs<T extends ResolvableUpload> {
  /** Uploads for the company, most recent first. */
  uploads: T[];
  /** Explicit pin from ?upload=<id>, if present. */
  requestedUploadId?: string | null;
  /** Period year from the route. */
  periodYear: number;
  /** Fiscal-period fallback for legacy uploads without period_year. */
  derivePeriodYear: (upload: T) => number;
}

export function resolveActiveUpload<T extends ResolvableUpload>(
  args: ResolveActiveUploadArgs<T>,
): T | null {
  const { uploads, requestedUploadId, periodYear, derivePeriodYear } = args;

  // 0. Explicit pin always wins, including a historical (retired/superseded) upload the user chose to view.
  if (requestedUploadId) {
    const pinned = uploads.find((u) => u.id === requestedUploadId);
    if (pinned) return pinned;
  }

  // Automatic resolution only ever considers uploads that can be current.
  const candidates = uploads.filter(isActiveLifecycle);

  // 1. Exact period_year column match.
  const exact = candidates.find((u) => u.period_year === periodYear);
  if (exact) return exact;

  // 2. Derived fiscal period for legacy uploads.
  const derived = candidates.find((u) => derivePeriodYear(u) === periodYear);
  if (derived) return derived;

  // 3. Most recent upload.
  // Never another period's upload: a period with no upload of its own shows its own empty state (the uploader).
  // Falling back to the most recent upload of ANY period let Prepare show, and Replace/Discard act on, a different
  // period's source (found by the PR #32 staging browser suite: a discard on an empty FY2023 page removed FY2024's
  // upload). An explicit ?upload= pin above still opens any upload the caller can read.
  return null;
}

/** Canonical route for a pinned upload inside the Prepare stage. */
export function buildPrepareUploadRoute(
  companyId: string,
  periodYear: number,
  uploadId?: string | null,
): string {
  const base = `/workspace/${companyId}/${periodYear}/prepare`;
  return uploadId ? `${base}?upload=${uploadId}` : base;
}

/**
 * Canonical route for "take me straight to the unresolved accounts".
 *
 * The exception count on the Overview and this route are the same control:
 * status → reason → action is one interaction surface, so the accountant never
 * reads a count on one screen and then hunts for the panel on another.
 */
export function buildPrepareReviewRoute(
  companyId: string,
  periodYear: number,
  uploadId?: string | null,
): string {
  const base = buildPrepareUploadRoute(companyId, periodYear, uploadId);
  return `${base}${base.includes("?") ? "&" : "?"}review=unresolved`;
}
