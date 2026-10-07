/**
 * workspaceSetupClient — the ONLY client path to workspace setup state. Thin, typed, and free of workflow logic:
 * every rule (authorisation, one open engagement per period, transitions, jurisdiction gating, idempotency, concurrency)
 * is enforced by the database inside `open_engagement_with_scope`, `record_engagement_data_start` and
 * `get_engagement_setup_state` (migration 20260920100000). The client neither compensates nor infers.
 *
 * State is keyed by the ENGAGEMENT (the workspace), never by the user: every authorised member reads the same value.
 */

import type { EngagementCapability } from "./mandate";
import { isCapabilityCustomerVisible } from "./moduleAvailability";

/** Refused client-side before any request: a withheld service (moduleAvailability.ts) cannot be chosen from this app. */
export const SERVICE_NOT_AVAILABLE_MESSAGE = "This service is not currently available.";
import type { DataStartChoice } from "./onboardingState";

export type SetupErrorKind = "NOT_AUTHORISED" | "JURISDICTION_REQUIRED" | "CONFLICT" | "INVALID" | "NOT_FOUND" | "UNKNOWN";

export class WorkspaceSetupError extends Error {
  constructor(readonly kind: SetupErrorKind, message: string) {
    super(message);
    this.name = "WorkspaceSetupError";
  }
}

export function classifySetupError(e: { code?: string | null; message?: string | null } | null | undefined): WorkspaceSetupError {
  const code = e?.code ?? "";
  const message = e?.message ?? "The request could not be completed.";
  if (code === "42501") return new WorkspaceSetupError("NOT_AUTHORISED", "You do not have permission to change this workspace's setup.");
  if (code === "PT422" || /JURISDICTION_REQUIRED/.test(message)) return new WorkspaceSetupError("JURISDICTION_REQUIRED", "Select the filing jurisdiction before adding this service.");
  if (code === "PT409" || /^CONFLICT|JURISDICTION_LOCKED/.test(message)) return new WorkspaceSetupError("CONFLICT", message.replace(/^(CONFLICT|JURISDICTION_LOCKED):\s*/, ""));
  if (code === "22023") return new WorkspaceSetupError("INVALID", message.replace(/^INVALID:\s*/, ""));
  if (code === "P0002") return new WorkspaceSetupError("NOT_FOUND", "This workspace could not be found.");
  return new WorkspaceSetupError("UNKNOWN", message);
}

export interface OpenedEngagement {
  readonly engagementId: string;
  readonly periodId: string;
  readonly created: boolean;
  readonly granted: readonly EngagementCapability[];
}

export interface SetupState {
  readonly dataStart: DataStartChoice | null;
  readonly sequence: number;
}

export interface RecordedChoice {
  readonly dataStart: DataStartChoice;
  readonly changed: boolean;
  readonly replay: boolean;
}

/** The minimal RPC surface used (the Supabase client satisfies it via a cast at the call site; tests pass a fake). */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw classifySetupError(error);
  return data as T;
}

/** Transactional create-or-get + idempotent grants. Safe to call repeatedly and concurrently. */
export async function openEngagementWithScope(client: RpcClient, input: { companyId: string; year: number; capabilities: readonly EngagementCapability[]; engagementType?: string }): Promise<OpenedEngagement> {
  if (!input.capabilities.every(isCapabilityCustomerVisible)) throw new Error(SERVICE_NOT_AVAILABLE_MESSAGE);
  const r = await call<{ engagementId: string; periodId: string; created: boolean; granted: EngagementCapability[] }>(client, "open_engagement_with_scope", {
    p_company_id: input.companyId,
    p_period_year: input.year,
    p_capabilities: [...new Set(input.capabilities)],
    p_engagement_type: input.engagementType ?? "composite",
  });
  return { engagementId: r.engagementId, periodId: r.periodId, created: r.created, granted: r.granted };
}

export async function getSetupState(client: RpcClient, engagementId: string): Promise<SetupState> {
  const r = await call<{ dataStart: DataStartChoice | null; sequence: number }>(client, "get_engagement_setup_state", { p_engagement_id: engagementId });
  return { dataStart: r.dataStart ?? null, sequence: Number(r.sequence ?? 0) };
}

/**
 * Records the decision. `expected` is the state the caller last saw (null = undecided); the server refuses a stale or
 * conflicting request with an explicit CONFLICT and treats an exact replay as success.
 */
export async function recordDataStart(client: RpcClient, engagementId: string, choice: DataStartChoice, expected: DataStartChoice | null): Promise<RecordedChoice> {
  const r = await call<{ dataStart: DataStartChoice; changed: boolean; replay: boolean }>(client, "record_engagement_data_start", {
    p_engagement_id: engagementId,
    p_choice: choice,
    p_expected_state: expected,
  });
  return { dataStart: r.dataStart, changed: !!r.changed, replay: !!r.replay };
}

export async function setFilingJurisdiction(client: RpcClient, companyId: string, code: string | null): Promise<string | null> {
  return call<string | null>(client, "set_company_filing_jurisdiction", { p_company_id: companyId, p_jurisdiction: code });
}

// ── I1-A: explicit reporting periods (migration 20261009100000) ──────────────────────────────────────────────────────

/** Refusals the server returns as answers (nothing was created or changed). */
export type PeriodRefusalCode =
  | "PERIOD_OVERLAP"
  | "PERIOD_YEAR_TAKEN"
  | "PERIOD_DATES_UNCONFIRMED"
  | "CURRENCY_DIFFERS_FROM_EXISTING"
  | "PRIOR_NOT_ADJACENT"
  | "PRIOR_DATES_UNCONFIRMED"
  | "PRIOR_YEAR_TAKEN"
  | "PRIOR_LINK_CONFLICT"
  | "END_DIFFERS_FROM_YEAR_END"
  | "PERIOD_LOCKED_BY_PROCESSING"
  | "SCOPE_REQUIRES_REVIEWER"
  | "NOT_A_LEGACY_PERIOD"
  | "IN_PROGRESS";

export const PERIOD_REFUSAL_COPY: Readonly<Record<PeriodRefusalCode, string>> = Object.freeze({
  PERIOD_OVERLAP: "These dates overlap another reporting period of this company. Choose dates that do not overlap.",
  PERIOD_YEAR_TAKEN: "Another reporting period already ends in this year. Open that period, or choose different dates.",
  PERIOD_DATES_UNCONFIRMED: "A period ending in this year exists but its dates are not recorded. Confirm its dates first.",
  CURRENCY_DIFFERS_FROM_EXISTING: "This period already exists with a different reporting currency.",
  PRIOR_NOT_ADJACENT: "The prior period must end the day before this period starts.",
  PRIOR_DATES_UNCONFIRMED: "A prior period ending in that year exists but its dates are not recorded. Confirm its dates first.",
  PRIOR_YEAR_TAKEN: "A different period already ends in the prior year. Use its dates, or leave the prior year out.",
  PRIOR_LINK_CONFLICT: "This period is already linked to a different prior period.",
  END_DIFFERS_FROM_YEAR_END: "The end date must be the period's recorded year end.",
  PERIOD_LOCKED_BY_PROCESSING: "A trial balance in this period has already been checked, so its dates and currency are fixed. A reviewer can complete the dates of a legacy period, with a reason.",
  SCOPE_REQUIRES_REVIEWER: "Choosing services other than the trial balance needs a reviewer. Set up the period with the trial balance only, or ask a reviewer.",
  NOT_A_LEGACY_PERIOD: "This period's dates are already confirmed.",
  IN_PROGRESS: "A trial balance in this period is being checked right now. Try again when the check has finished.",
});

/** The backend does not have this function yet (PGRST202 / 42883): the feature is unavailable, not failed. */
export class SetupFeatureUnavailable extends Error {
  constructor() { super("This setup option is not available yet."); this.name = "SetupFeatureUnavailable"; }
}

export type PeriodOpenResult =
  | { readonly outcome: "opened"; readonly engagementId: string; readonly periodId: string; readonly priorPeriodId: string | null; readonly periodYear: number; readonly created: boolean; readonly granted: readonly EngagementCapability[] }
  | { readonly outcome: "refused"; readonly code: PeriodRefusalCode; readonly message: string; readonly periodId: string | null };

async function callPeriod<T>(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") throw new SetupFeatureUnavailable();
    throw classifySetupError(error);
  }
  return data as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refusal(raw: { code?: unknown; periodId?: unknown }): PeriodOpenResult {
  const code = String(raw.code) as PeriodRefusalCode;
  if (!(code in PERIOD_REFUSAL_COPY)) throw new WorkspaceSetupError("UNKNOWN", "The request could not be completed.");
  return { outcome: "refused", code, message: PERIOD_REFUSAL_COPY[code], periodId: typeof raw.periodId === "string" ? raw.periodId : null };
}

/**
 * Opens (or reuses) the engagement for an explicitly dated period in an explicitly chosen currency, optionally with
 * the adjacent prior period. Dates are ISO yyyy-mm-dd. The server validates everything; nothing is defaulted here.
 */
export async function openEngagementWithPeriod(client: RpcClient, input: {
  companyId: string; periodStart: string; periodEnd: string; reportingCurrency: string;
  capabilities: readonly EngagementCapability[]; engagementType?: string;
  prior?: { start: string; end: string; currency?: string };
}): Promise<PeriodOpenResult> {
  if (!input.capabilities.every(isCapabilityCustomerVisible)) throw new Error(SERVICE_NOT_AVAILABLE_MESSAGE);
  for (const d of [input.periodStart, input.periodEnd, input.prior?.start, input.prior?.end].filter((x): x is string => x !== undefined)) {
    if (!ISO_DATE.test(d)) throw new WorkspaceSetupError("INVALID", "Dates must be given as yyyy-mm-dd.");
  }
  const r = await callPeriod<Record<string, unknown>>(client, "open_engagement_with_period", {
    p_company_id: input.companyId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_reporting_currency: input.reportingCurrency,
    p_capabilities: [...new Set(input.capabilities)],
    p_engagement_type: input.engagementType ?? "composite",
    p_prior_start: input.prior?.start ?? null,
    p_prior_end: input.prior?.end ?? null,
    p_prior_currency: input.prior?.currency ?? null,
  });
  if (r.outcome === "refused") return refusal(r);
  return {
    outcome: "opened",
    engagementId: String(r.engagementId),
    periodId: String(r.periodId),
    priorPeriodId: typeof r.priorPeriodId === "string" ? r.priorPeriodId : null,
    periodYear: Number(r.periodYear),
    created: r.created === true,
    granted: (r.granted as EngagementCapability[]) ?? [],
  };
}

export type ConfirmDatesResult =
  | { readonly outcome: "confirmed"; readonly periodId: string; readonly changed: boolean }
  | { readonly outcome: "refused"; readonly code: PeriodRefusalCode; readonly message: string };

/** Confirms (or states, for a period without recorded dates) a period's start and end dates. */
export async function confirmPeriodDates(client: RpcClient, periodId: string, start: string, end: string): Promise<ConfirmDatesResult> {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new WorkspaceSetupError("INVALID", "Dates must be given as yyyy-mm-dd.");
  const r = await callPeriod<Record<string, unknown>>(client, "confirm_period_dates", { p_period_id: periodId, p_start: start, p_end: end });
  if (r.outcome === "refused") {
    const x = refusal(r);
    return x.outcome === "refused" ? { outcome: "refused", code: x.code, message: x.message } : (() => { throw new Error("unreachable"); })();
  }
  return { outcome: "confirmed", periodId: String(r.periodId), changed: r.changed === true };
}

export type CompleteLegacyDatesResult =
  | { readonly outcome: "completed"; readonly periodId: string; readonly changed: boolean; readonly invalidated: readonly string[] }
  | { readonly outcome: "refused"; readonly code: PeriodRefusalCode; readonly message: string };

/**
 * Completes the dates of a LEGACY period that already has processed history (review_close; a reason is recorded).
 * When the dates change, the server invalidates every result in force for the period's trial balances in the same
 * transaction; they need a new check.
 */
export async function completeLegacyPeriodDates(client: RpcClient, periodId: string, start: string, end: string, reason: string): Promise<CompleteLegacyDatesResult> {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new WorkspaceSetupError("INVALID", "Dates must be given as yyyy-mm-dd.");
  if (reason.trim().length < 10) throw new WorkspaceSetupError("INVALID", "State why these dates are right (at least 10 characters).");
  const r = await callPeriod<Record<string, unknown>>(client, "complete_legacy_period_dates", { p_period_id: periodId, p_start: start, p_end: end, p_reason: reason });
  if (r.outcome === "refused") {
    const x = refusal(r);
    return x.outcome === "refused" ? { outcome: "refused", code: x.code, message: x.message } : (() => { throw new Error("unreachable"); })();
  }
  if (r.outcome !== "completed") throw new WorkspaceSetupError("UNKNOWN", "The request could not be completed.");
  return { outcome: "completed", periodId: String(r.periodId), changed: r.changed === true, invalidated: Array.isArray(r.invalidated) ? (r.invalidated as string[]) : [] };
}
