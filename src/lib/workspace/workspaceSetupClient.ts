/**
 * workspaceSetupClient — the ONLY client path to workspace setup state. Thin, typed, and free of workflow logic:
 * every rule (authorisation, one open engagement per period, transitions, jurisdiction gating, idempotency, concurrency)
 * is enforced by the database inside `open_engagement_with_scope`, `record_engagement_data_start` and
 * `get_engagement_setup_state` (migration 20260920100000). The client neither compensates nor infers.
 *
 * State is keyed by the ENGAGEMENT (the workspace), never by the user: every authorised member reads the same value.
 */

import type { EngagementCapability } from "./mandate";
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
