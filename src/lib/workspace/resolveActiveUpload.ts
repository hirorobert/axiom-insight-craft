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

  // 0. Explicit pin always wins.
  if (requestedUploadId) {
    const pinned = uploads.find((u) => u.id === requestedUploadId);
    if (pinned) return pinned;
  }

  // 1. Exact period_year column match.
  const exact = uploads.find((u) => u.period_year === periodYear);
  if (exact) return exact;

  // 2. Derived fiscal period for legacy uploads.
  const derived = uploads.find((u) => derivePeriodYear(u) === periodYear);
  if (derived) return derived;

  // 3. Most recent upload.
  return uploads.length > 0 ? uploads[0] : null;
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
