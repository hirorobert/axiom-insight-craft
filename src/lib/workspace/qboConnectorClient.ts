/**
 * qboConnectorClient — the browser's side of "Import from QuickBooks" (charter B9). It only ASKS: every financial write is made by an Edge Function
 * (qbo-connect-start, qbo-pull-trial-balance), which judges the person's right itself, and the connection's status is read through the status function that
 * never returns a token, an envelope or a key. Nothing here sees a QuickBooks password, a token or a response body.
 *
 * QBO_CONNECTOR_ENABLED is a reviewed source constant (the gate pattern of src/lib/workbench/gate.ts and TWO_PERIOD_INTAKE_ENABLED). It stays false until the
 * storage migration is applied, the three functions are deployed and the secrets are set; while false the upload page is exactly as before and the card is not
 * rendered. QBO_ENVIRONMENT stays 'sandbox' (Intuit's development app) until Intuit has approved production access.
 */
export const QBO_CONNECTOR_ENABLED = false;
export const QBO_ENVIRONMENT: "sandbox" | "production" = "sandbox";

export interface QboConnectionRow {
  id: string; realm_id: string; environment: string; status: string; refresh_expires_at: string | null; created_at: string;
}
export type QboConnectionState =
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "connected"; realmId: string }
  | { kind: "reconnect"; realmId: string };

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
type FnClient = { functions: { invoke(name: string, opts: { body: unknown }): Promise<{ data: unknown; error: unknown }> } };

/** The newest live connection of this environment decides the state; a disconnected one counts as none. A read that failed is "unavailable" (the card hides). */
export function connectionState(rows: QboConnectionRow[] | null, environment: "sandbox" | "production"): QboConnectionState {
  if (rows === null) return { kind: "unavailable" };
  const live = rows.filter((r) => r.environment === environment && r.status !== "disconnected")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const newest = live[0];
  if (!newest) return { kind: "none" };
  return newest.status === "active" ? { kind: "connected", realmId: newest.realm_id } : { kind: "reconnect", realmId: newest.realm_id };
}

export async function fetchConnections(client: RpcClient, companyId: string): Promise<QboConnectionRow[] | null> {
  try {
    const { data, error } = await client.rpc("qbo_connection_status", { p_company_id: companyId });
    return error || !Array.isArray(data) ? null : (data as QboConnectionRow[]);
  } catch {
    return null;
  }
}

/** The outcome word of a function answer, whether it came back as data or as an error whose response body carries it. */
async function readAnswer(res: { data: unknown; error: unknown }): Promise<Record<string, unknown> | null> {
  if (res.data && typeof res.data === "object") return res.data as Record<string, unknown>;
  try {
    return ((await (res.error as { context?: { json?: () => Promise<unknown> } })?.context?.json?.()) ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

const GENERIC = "The import could not be completed. Nothing was imported. Please try again.";
/** Plain sentences for every outcome the functions answer. None mentions a token, an engine or a vendor term beyond QuickBooks. */
export const QBO_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: "Please sign in again, then try once more.",
  forbidden: "You don't have permission to import into this workspace.",
  not_configured: "QuickBooks import isn't set up yet.",
  state_failed: "The connection could not be started. Please try again.",
  not_connected: "QuickBooks isn't connected yet. Connect it first.",
  reconnect_needed: "The QuickBooks connection has expired or was removed. Connect again to continue.",
  busy: "Another import is running for this QuickBooks company. Wait a moment, then try again.",
  rate_limited: "QuickBooks is asking us to slow down. Try again in a few minutes.",
  quickbooks_unavailable: "QuickBooks isn't responding right now. Try again in a few minutes.",
  quickbooks_rejected: "QuickBooks refused the request. Nothing was imported.",
  report_failed: "QuickBooks returned an answer that could not be used. Nothing was imported.",
  report_unreadable: "QuickBooks returned an answer that could not be read. Nothing was imported.",
  report_too_large: "The QuickBooks report is too large to import this way. Export it from QuickBooks and upload the file instead.",
  report_refused: "The report from QuickBooks isn't one this import can read safely, so nothing was imported. Export it from QuickBooks and upload the file instead.",
  period_mismatch: "QuickBooks returned a different period from the one asked for, so nothing was imported.",
  active_upload_exists: "A trial balance is already saved for this period. To replace it, use Replace trial balance and upload a file.",
  provenance_failed: "Nothing was imported, because the record of where these figures came from could not be saved. Please try again.",
  invalid_request: GENERIC, reserve_failed: GENERIC, store_failed: GENERIC, register_failed: GENERIC, token_unreadable: GENERIC, pull_failed: GENERIC,
});
export const messageFor = (outcome: string | undefined): string => (outcome && QBO_MESSAGES[outcome]) || GENERIC;

export async function startConnect(client: FnClient, a: { companyId: string; periodYear: number; environment: "sandbox" | "production" }): Promise<{ kind: "redirect"; url: string } | { kind: "failed"; message: string }> {
  try {
    const body = await readAnswer(await client.functions.invoke("qbo-connect-start", { body: { companyId: a.companyId, environment: a.environment, periodYear: a.periodYear } }));
    // The browser only ever follows an https address of the authorisation page that the function built.
    if (body?.outcome === "authorize" && typeof body.authorizeUrl === "string" && /^https:\/\/[^\s]+$/.test(body.authorizeUrl)) return { kind: "redirect", url: body.authorizeUrl };
    return { kind: "failed", message: messageFor(typeof body?.outcome === "string" ? body.outcome : undefined) };
  } catch {
    return { kind: "failed", message: GENERIC };
  }
}

export interface PullInput { companyId: string; environment: "sandbox" | "production"; realmId: string; startDate: string; endDate: string; periodYear: number; periodId: string | null; engagementId: string | null }
/** Said when the trial balance is saved and its source record is already on file, but the final link between them is still being finished (HTTP 202). */
export const RECORD_PENDING_NOTE = "The record of where these figures came from is saved and is being linked to this trial balance; that finishes by itself.";
export type PullOutcome =
  | { kind: "imported"; uploadId: string; accountCount: number; currency: string; recordPending: boolean }
  | { kind: "failed"; outcome: string; message: string; detail?: string; uploadId?: string };

export async function pullFromQuickBooks(client: FnClient, a: PullInput): Promise<PullOutcome> {
  try {
    const body = await readAnswer(await client.functions.invoke("qbo-pull-trial-balance", { body: {
      companyId: a.companyId, environment: a.environment, realmId: a.realmId, startDate: a.startDate, endDate: a.endDate, periodYear: a.periodYear,
      ...(a.periodId ? { periodId: a.periodId } : {}), ...(a.engagementId ? { engagementId: a.engagementId } : {}),
    } }));
    const outcome = typeof body?.outcome === "string" ? body.outcome : undefined;
    if ((outcome === "imported" || outcome === "imported_record_pending") && typeof body?.uploadId === "string") {
      return { kind: "imported", uploadId: body.uploadId, accountCount: Number(body.accountCount) || 0, currency: typeof body.currency === "string" ? body.currency : "", recordPending: outcome === "imported_record_pending" };
    }
    return {
      kind: "failed", outcome: outcome ?? "pull_failed", message: messageFor(outcome),
      ...(typeof body?.message === "string" ? { detail: body.message } : {}), ...(typeof body?.uploadId === "string" ? { uploadId: body.uploadId } : {}),
    };
  } catch {
    return { kind: "failed", outcome: "pull_failed", message: GENERIC };
  }
}
