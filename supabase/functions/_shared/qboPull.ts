/**
 * qboPull — one user-initiated import of a QuickBooks Online Trial Balance into a workspace (charter B9, plan section 3). Pure orchestration with injected
 * dependencies: unit-tested in Node, run unchanged in the qbo-pull-trial-balance Edge Function. A connector is another SOURCE OF THE SAME FILE: the
 * report becomes the canonical CSV, the CSV enters the SAME upload steps as a manual file (reserve, store, register: each judged for the person), and the
 * existing processing and review gates then apply unchanged. Nothing here certifies, accepts or adjusts a figure.
 *
 * ORDER (each step refuses before the next begins):
 *   1 login  2 BOTH rights an import needs, before Intuit is touched: prepare_trial_balance (the connector's own) and manage_source_files (the upload
 *     steps', judged again for the person at reserve and register)  3 a live connection  4 open the stored refresh token
 *   5 take the refresh LEASE (a second simultaneous import is told "busy" here and never reaches Intuit; only this import's own lease id gives it back)
 *   6 refresh (Intuit; abandoned after 30 s, well inside the bounded operation lease)
 *   7 ROTATE: the new refresh token is sealed and stored by compare-and-swap BEFORE the new access token is used; a lost race stops here. The swap is
 *     safe to retry, so a lost answer or a passing database fault is retried rather than throwing the newest token away.
 *     The one window no code can close: if the function dies after Intuit has issued the new token and before the swap is stored, the stored token
 *     may be one Intuit no longer accepts. The next import then gets invalid_grant and the connection asks for a reconnect; nothing is imported wrongly.
 *   8 verify saved period against Preferences fiscal YTD, then fetch through the read-only guard  9 convert (qboTrialBalance: 25 reasons to refuse, never repaired)  10 check the report's own period
 *   11 hash the raw response, the canonical file and the normalised result  12 reserve the upload
 *   13 EVIDENCE FIRST: record the intent (the facts and the three fingerprints, keyed by the reservation). If this cannot be written, NOTHING is stored.
 *   14 store the file and register the upload as the person  15 link the intent to the upload the reservation created (idempotent, retried).
 *      If only this last step fails the evidence is already complete; the outcome says so ("imported_record_pending", HTTP 202) and the next import or
 *      the recovery function finishes the link. No outcome ever says "imported" without the link, and none hides a missing one.
 * Never in an outcome, a log field or an error: a token, an envelope, a response body.
 */
import { parseQboTrialBalanceReport, toCanonicalCsv, type QboTbRefusalCode } from "./qboTrialBalance.ts";
import { connectionBinding, type EnvelopeBinding } from "./qboTokenEnvelope.ts";
import type { TokenResult } from "./qboTokenClient.ts";
import { alignQboFiscalBasis, type QboSavedPeriod, type QboFiscalBasis } from "./qboFiscalBasis.ts";
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_CHARS = 5_000_000;
/** Long enough for one refresh round trip (the token call is abandoned after QBO_TIMEOUTS_MS.token = 30 s), plus bounded fiscal/report reads, short enough that a crashed import never blocks the next for long. */
export const REFRESH_LEASE_SECONDS = 300;

export interface PullRequest {
  companyId: string; environment: QboEnvironment; realmId: string; startDate: string; endDate: string; periodYear: number;
  accountingMethod?: "Accrual" | "Cash"; periodId: string | null; engagementId: string | null;
}

const REQUIRED = ["companyId", "environment", "realmId", "startDate", "endDate", "periodYear"];
const OPTIONAL = ["accountingMethod", "periodId", "engagementId"];
const validDate = (s: unknown): s is string => typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

/** Exactly these keys, nothing else: a bucket, path, user or token in the body is refused, never read. */
export function parsePullRequest(body: unknown): PullRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!REQUIRED.every((k) => k in o) || keys.some((k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k))) return null;
  if (typeof o.companyId !== "string" || !UUID.test(o.companyId)) return null;
  if (o.environment !== "production" && o.environment !== "sandbox") return null;
  if (typeof o.realmId !== "string" || !/^[0-9]{1,20}$/.test(o.realmId)) return null;
  if (!validDate(o.startDate) || !validDate(o.endDate) || o.startDate > o.endDate) return null;
  if (typeof o.periodYear !== "number" || !Number.isInteger(o.periodYear) || o.periodYear < 2000 || o.periodYear > 2100) return null;
  if (o.accountingMethod !== undefined && o.accountingMethod !== "Accrual" && o.accountingMethod !== "Cash") return null;
  for (const k of ["periodId", "engagementId"]) if (o[k] !== undefined && o[k] !== null && (typeof o[k] !== "string" || !UUID.test(o[k] as string))) return null;
  return {
    companyId: o.companyId, environment: o.environment, realmId: o.realmId, startDate: o.startDate, endDate: o.endDate, periodYear: o.periodYear,
    ...(o.accountingMethod ? { accountingMethod: o.accountingMethod as "Accrual" | "Cash" } : {}),
    periodId: (o.periodId as string | null | undefined) ?? null, engagementId: (o.engagementId as string | null | undefined) ?? null,
  };
}

export interface StoredConnection { id: string; status: "active" | "reconnect_needed"; envelope: string | null }
/** The facts recorded BEFORE the file is stored, keyed by the upload reservation (the workspace comes from the reservation, never from here). */
export interface ProvenanceRecord {
  reservationId: string; connectionId: string; actorUserId: string; realmId: string; environment: QboEnvironment; startDate: string; endDate: string;
  fiscalBasis: QboFiscalBasis & { operationLeaseId: string }; periodId: string; accountingMethod: string | null; minorVersion: number | null; currency: string; accountCount: number; rawSha256: string; canonicalSha256: string; resultSha256: string;
}
export type CompletePullResult = "completed" | "already" | "not_registered" | "no_intent" | "no_reservation";

export interface PullDeps {
  authenticate(): Promise<string | null>;
  savedPeriod(userId: string, request: PullRequest): Promise<QboSavedPeriod | null>;
  fetchPreferences(environment: QboEnvironment, realmId: string, accessToken: string): Promise<{ status: number; text: string }>;
  connectionActive(connectionId: string): Promise<boolean>;
  /** workspace_authority_basis(user, company, 'prepare_trial_balance') is not null. */
  canPrepare(userId: string, companyId: string): Promise<boolean>;
  /** workspace_authority_basis(user, company, 'manage_source_files') is not null: the right the upload steps need. Both are required; neither implies the other. */
  canManageSources(userId: string, companyId: string): Promise<boolean>;
  /** Compare-and-set lease on the connection: the lease's own id for exactly one caller at a time, and only for the envelope presented; otherwise null. Lapses by itself. */
  acquireRefreshLease(connectionId: string, envelope: string): Promise<string | null>;
  /** Gives the lease back. Only the holder's own lease id releases it, so this never clears a lease another import took after ours lapsed. */
  releaseRefreshLease(connectionId: string, leaseId: string): Promise<void>;
  /** Best-effort recovery of earlier imports whose link was not written; never on the critical path. */
  completePending?(): Promise<void>;
  /** Waits between retries of an idempotent evidence write. Injected so tests need no clock. */
  pause?(ms: number): Promise<void>;
  findConnection(companyId: string, realmId: string, environment: QboEnvironment): Promise<StoredConnection | null>;
  openRefreshToken(envelope: string, binding: EnvelopeBinding): Promise<string | null>;
  refresh(environment: QboEnvironment, refreshToken: string): Promise<TokenResult>;
  sealRefreshToken(refreshToken: string, binding: EnvelopeBinding): Promise<string>;
  /** Compare-and-swap: true only if `expected` was still the stored envelope, or if `next` already is (a retry whose first answer was lost). Safe to retry. */
  rotate(connectionId: string, expected: string, next: string, refreshExpiresAt: string, hardExpiresAt: string | null, leaseId: string): Promise<boolean>;
  /** Deletes the token Intuit refused, and only that one: if another import has stored a newer token meanwhile, nothing changes. */
  markReconnectNeeded(connectionId: string, refusedEnvelope: string): Promise<void>;
  fetchReport(environment: QboEnvironment, realmId: string, accessToken: string, p: { startDate: string; endDate: string; accountingMethod?: "Accrual" | "Cash" }): Promise<{ status: number; text: string }>;
  sha256Hex(data: string | Uint8Array): Promise<string>;
  summarise(csv: Uint8Array, currency: string, periodYear: number): Promise<{ accountCount: number; resultSha256: string }>;
  reserve(companyId: string, fileName: string): Promise<{ ok: true; reservationId: string; objectPath: string } | { ok: false; reason: "forbidden" | "failed" }>;
  putObject(path: string, bytes: Uint8Array): Promise<boolean>;
  removeObject(path: string): Promise<void>;
  register(reservationId: string, fileSize: number, periodYear: number, periodId: string | null, engagementId: string | null): Promise<{ outcome: string; uploadId: string | null }>;
  /** Idempotent for the same facts (so it is retried); throws if the evidence cannot be written. */
  recordIntent(r: ProvenanceRecord): Promise<void>;
  /** Idempotent: writes the provenance row from the intent and the reservation's own upload id. */
  completePull(reservationId: string): Promise<CompletePullResult>;
  minorVersion: number | null;
}

type Status = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;
export type PullResult =
  | { status: 200; outcome: "imported"; uploadId: string; currency: string; accountCount: number; startDate: string; endDate: string }
  | { status: 202; outcome: "imported_record_pending"; uploadId: string; currency: string; accountCount: number; startDate: string; endDate: string }
  | { status: Status; outcome: string; code?: QboTbRefusalCode; message?: string; uploadId?: string };

const fail = (status: Status, outcome: string, extra: { code?: QboTbRefusalCode; message?: string; uploadId?: string } = {}): PullResult => ({ status, outcome, ...extra });

const EVIDENCE_ATTEMPTS = 3;
/** Runs an idempotent write up to three times with a short wait between; never throws. */
async function attempt<T>(fn: () => Promise<T>, pause: (ms: number) => Promise<void>): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let i = 0; i < EVIDENCE_ATTEMPTS; i++) {
    try { return { ok: true, value: await fn() }; } catch { if (i < EVIDENCE_ATTEMPTS - 1) await pause(250 * (i + 1)).catch(() => undefined); }
  }
  return { ok: false };
}

export async function runQboPull(deps: PullDeps, req: PullRequest): Promise<PullResult> {
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const userId = await deps.authenticate();
  if (!userId) return fail(401, "unauthenticated");
  // Both rights, before Intuit is touched: a person who could prepare but not upload must not cause a token refresh that can only end in a refusal.
  if (!(await deps.canPrepare(userId, req.companyId))) return fail(403, "forbidden");
  if (!(await deps.canManageSources(userId, req.companyId))) return fail(403, "forbidden");
  const period = await deps.savedPeriod(userId, req);
  if (!period || period.companyId !== req.companyId || period.year !== req.periodYear || period.id !== req.periodId
      || period.start !== req.startDate || period.end !== req.endDate) return fail(422, "saved_period_mismatch");
  await deps.completePending?.().catch(() => undefined);

  const conn = await deps.findConnection(req.companyId, req.realmId, req.environment);
  if (!conn) return fail(404, "not_connected");
  if (conn.status !== "active" || !conn.envelope) return fail(409, "reconnect_needed");
  const presented = conn.envelope;   // the envelope this import opens, leases, presents and swaps from
  const binding = connectionBinding(req.companyId, req.realmId, req.environment);
  const stored = await deps.openRefreshToken(presented, binding);
  if (!stored) return fail(500, "token_unreadable");

  // The lease comes BEFORE Intuit: two simultaneous imports can never present the same refresh token together. The second is told "busy" without any call.
  const leaseId = await deps.acquireRefreshLease(conn.id, presented);
  if (!leaseId) return fail(409, "busy");
  let accessToken: string;
  try {
    const refreshed = await deps.refresh(req.environment, stored);
    if (!refreshed.ok) {
      // Only the token we presented is deleted: if another import stored a newer one meanwhile, the refusal was of an out-of-date token.
      if (refreshed.reason === "invalid_grant") { await deps.markReconnectNeeded(conn.id, presented); return fail(409, "reconnect_needed"); }
      return refreshed.reason === "unavailable" ? fail(503, "quickbooks_unavailable") : fail(502, "quickbooks_rejected");
    }
    // Intuit rolls the refresh token over: the newest one is stored BEFORE the new access token is used. A lost race (another pull rotated first) stops here.
    // The swap is retried: it is safe to retry, and Intuit may already have retired the token we presented, so the new one must not be dropped lightly.
    const next = await deps.sealRefreshToken(refreshed.tokens.refreshToken, binding);
    const rotated = await attempt(() => deps.rotate(conn.id, presented, next, refreshed.tokens.refreshExpiresAt, refreshed.tokens.hardExpiresAt, leaseId), pause);
    if (!rotated.ok) return fail(500, "pull_failed");
    if (!rotated.value) return fail(409, "busy");
    accessToken = refreshed.tokens.accessToken;

    // All work remains inside the operation lease. SQL keeps it across rotation and fences registration.
    const preferences = await deps.fetchPreferences(req.environment, req.realmId, accessToken);
    if (preferences.status === 429 || preferences.status === 402) return fail(429, "rate_limited");
    if (preferences.status !== 200) return fail(503, "fiscal_configuration_missing");
    let preferencesJson: unknown;
    try { preferencesJson = JSON.parse(preferences.text); } catch { return fail(422, "fiscal_configuration_missing"); }
    const alignment = alignQboFiscalBasis(period, preferencesJson, await deps.sha256Hex(preferences.text));
    if (!alignment.ok) return fail(422, alignment.outcome, { message: alignment.message });
    const fiscalBasis = alignment.basis;
    if (req.accountingMethod && req.accountingMethod !== fiscalBasis.accountingMethod) return fail(422, "accounting_basis_mismatch");
    const res = await deps.fetchReport(req.environment, req.realmId, accessToken, { startDate: req.startDate, endDate: req.endDate, accountingMethod: fiscalBasis.accountingMethod });
    if (res.status === 429 || res.status === 402) return fail(429, "rate_limited");
    if (res.status === 413) return fail(502, "report_too_large");
    if (res.status >= 500) return fail(503, "quickbooks_unavailable");
    if (res.status !== 200) return fail(502, "report_failed");
    if (res.text.length > MAX_REPORT_CHARS) return fail(502, "report_too_large");
    let json: unknown;
    try { json = JSON.parse(res.text); } catch { return fail(502, "report_unreadable"); }

    const parsed = parseQboTrialBalanceReport(json);
    if (!parsed.ok) return fail(422, "report_refused", { code: parsed.code, message: parsed.message });
    const report = parsed.report;
    if (report.currency !== period.currency) return fail(422, "currency_mismatch");
    if (report.basis !== fiscalBasis.accountingMethod) return fail(422, "accounting_basis_mismatch");
    if (report.startPeriod !== fiscalBasis.fiscalStart || report.endPeriod !== req.endDate) {
      return fail(422, "period_mismatch", { message: `QuickBooks returned ${report.startPeriod} to ${report.endPeriod}, not the ${req.startDate} to ${req.endDate} that was asked for.` });
    }

    const csv = new TextEncoder().encode(toCanonicalCsv(report));
    const [rawSha256, canonicalSha256, summary] = await Promise.all([deps.sha256Hex(res.text), deps.sha256Hex(csv), deps.summarise(csv, report.currency, req.periodYear)]);

    const fileName = `quickbooks-${req.environment === "sandbox" ? "sandbox-" : ""}${req.realmId}-${req.endDate}.csv`;
    if (!(await deps.connectionActive(conn.id))) return fail(409, "disconnected");
    const reserved = await deps.reserve(req.companyId, fileName);
    if (!reserved.ok) return reserved.reason === "forbidden" ? fail(403, "forbidden") : fail(500, "reserve_failed");

    // EVIDENCE FIRST. Nothing is stored or registered unless the facts of this report are already on record. If they cannot be written, the import stops here
    // and says so: there is no upload, so there is nothing that lacks its evidence (the unused reservation expires and is swept by the existing sweeper).
    const intent = await attempt(() => deps.recordIntent({
      reservationId: reserved.reservationId, connectionId: conn.id, actorUserId: userId, realmId: req.realmId, environment: req.environment,
      startDate: fiscalBasis.fiscalStart, endDate: fiscalBasis.asOf, fiscalBasis: { ...fiscalBasis, operationLeaseId: leaseId }, periodId: period.id,
      accountingMethod: fiscalBasis.accountingMethod, minorVersion: deps.minorVersion, currency: report.currency,
      accountCount: summary.accountCount, rawSha256, canonicalSha256, resultSha256: summary.resultSha256,
    }), pause);
    if (!intent.ok) return fail(500, "provenance_failed");

    if (!(await deps.putObject(reserved.objectPath, csv))) return fail(500, "store_failed");
    const registered = await deps.register(reserved.reservationId, csv.byteLength, req.periodYear, req.periodId, req.engagementId);
    if ((registered.outcome !== "registered" && registered.outcome !== "already_registered") || !registered.uploadId) {
      if (registered.outcome === "unconfirmed") return fail(503, "registration_unconfirmed");
      await deps.removeObject(reserved.objectPath).catch(() => undefined);
      if (registered.outcome === "active_upload_exists") return fail(409, "active_upload_exists");
      if (registered.outcome === "forbidden") return fail(403, "forbidden");
      return fail(500, "register_failed");
    }

    // The upload exists and its evidence is already on record; link them. Idempotent, so a transient failure is simply retried.
    const linked = await attempt(() => deps.completePull(reserved.reservationId), pause);
    const done = { uploadId: registered.uploadId, currency: report.currency, accountCount: summary.accountCount, startDate: req.startDate, endDate: req.endDate };
    if (linked.ok && (linked.value === "completed" || linked.value === "already")) return { status: 200, outcome: "imported", ...done };
    return { status: 202, outcome: "imported_record_pending", ...done };
  } finally { await deps.releaseRefreshLease(conn.id, leaseId).catch(() => undefined); }
}
