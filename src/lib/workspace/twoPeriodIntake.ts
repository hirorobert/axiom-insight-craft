/**
 * twoPeriodIntake — one uploaded file registered as TWO trial balances: the current year and the prior year
 * (I1-B, migration 20261011100000). The server registers both in one transaction or neither
 * (register_two_period_uploads); each is an independent dataset with its own layout, checks and lifecycle, sharing one
 * managed source object that is kept while either year uses it.
 *
 * TWO_PERIOD_INTAKE_ENABLED is a reviewed source constant (the gate pattern of src/lib/workbench/gate.ts). It stays
 * false until the migration is applied to the hosted database; while false the uploader is exactly as before.
 */
import { SourceUploadError } from "@/lib/workspace/sourceUpload";

export const TWO_PERIOD_INTAKE_ENABLED = false;

export interface PeriodRow {
  id: string;
  period_label: string;
  fiscal_year_end: string;
  reporting_start: string | null;
  reporting_end: string | null;
}

const yearOf = (p: PeriodRow) => Number((p.reporting_end ?? p.fiscal_year_end).slice(0, 4));
const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The period immediately before the current one, by the server's own rule: dated periods meet exactly (the prior ends
 * the day before the current starts); otherwise consecutive years. Null when there is none — or more than one, since a
 * choice the person did not make is never guessed.
 */
export function adjacentPriorPeriod(periods: PeriodRow[], currentPeriodId: string): PeriodRow | null {
  const cur = periods.find((p) => p.id === currentPeriodId);
  if (!cur) return null;
  const matches = periods.filter((p) => p.id !== cur.id && (
    cur.reporting_start && p.reporting_end
      ? p.reporting_end === dayBefore(cur.reporting_start)
      : yearOf(p) === yearOf(cur) - 1));
  return matches.length === 1 ? matches[0] : null;
}

export type TwoPeriodOutcome =
  | "registered" | "already_registered" | "invalid_request" | "stale_reservation" | "forbidden" | "expired"
  | "object_missing" | "invalid_period" | "periods_not_adjacent" | "active_upload_exists" | "rejected";
interface TwoPeriodRow { outcome: TwoPeriodOutcome; current_upload_id: string | null; prior_upload_id: string | null; source_object_id: string | null; detail: string | null }
export interface TwoPeriodRpcClient {
  rpc(name: "register_two_period_uploads", args: {
    p_reservation_id: string; p_request_id: string; p_file_size: number; p_current_period_id: string; p_prior_period_id: string;
    p_current_engagement_id: string | null; p_prior_engagement_id: string | null;
  }): Promise<{ data: TwoPeriodRow[] | null; error: { message: string; code?: string } | null }>;
}

const MESSAGES: Partial<Record<TwoPeriodOutcome, string>> = {
  forbidden: "You don't have permission to manage this workspace's source files.",
  periods_not_adjacent: "The prior period must end immediately before this period starts.",
  invalid_period: "Both reporting periods must belong to this workspace.",
  active_upload_exists: "A trial balance is already active for one of these periods. Use Replace trial balance to swap it.",
  expired: "The upload reservation expired. Start the upload again.",
  object_missing: "The file has not reached storage yet.",
};

/**
 * Registers the uploaded file for both years. The request id makes a retry return the same pair; a different request
 * for an already-registered file also returns that pair. Nothing is registered unless both are.
 */
export async function registerTwoPeriodUpload(client: TwoPeriodRpcClient, args: {
  reservationId: string; requestId: string; fileSize: number; currentPeriodId: string; priorPeriodId: string; currentEngagementId?: string | null;
}): Promise<{ currentUploadId: string; priorUploadId: string }> {
  const { data, error } = await client.rpc("register_two_period_uploads", {
    p_reservation_id: args.reservationId, p_request_id: args.requestId, p_file_size: args.fileSize,
    p_current_period_id: args.currentPeriodId, p_prior_period_id: args.priorPeriodId,
    p_current_engagement_id: args.currentEngagementId ?? null, p_prior_engagement_id: null,
  });
  const r = data?.[0];
  if (error || !r) throw new SourceUploadError("Could not register the trial balances.", "register_failed", true);
  if ((r.outcome === "registered" || r.outcome === "already_registered") && r.current_upload_id && r.prior_upload_id) {
    return { currentUploadId: r.current_upload_id, priorUploadId: r.prior_upload_id };
  }
  // A file already registered for this year alone is not silently turned into a two-year registration.
  if (r.outcome === "already_registered") throw new SourceUploadError("This file was already registered for this period only.", r.outcome, false);
  throw new SourceUploadError(MESSAGES[r.outcome] ?? r.detail ?? "Could not register the trial balances.", r.outcome, r.outcome === "object_missing");
}
