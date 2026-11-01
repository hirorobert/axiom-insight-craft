/**
 * qboPull — one user-initiated import of a QuickBooks Online Trial Balance into a workspace (charter B9, plan section 3). Pure orchestration with injected
 * dependencies: unit-tested in Node, run unchanged in the qbo-pull-trial-balance Edge Function. A connector is another SOURCE OF THE SAME FILE: the
 * report becomes the canonical CSV, the CSV enters the SAME upload steps as a manual file (reserve, store, register: each judged for the person), and the
 * existing processing and review gates then apply unchanged. Nothing here certifies, accepts or adjusts a figure.
 *
 * ORDER (each step refuses before the next begins):
 *   1 login  2 the right to prepare a trial balance here  3 a live connection  4 open the stored refresh token  5 refresh (Intuit)
 *   6 ROTATE: the new refresh token is sealed and stored by compare-and-swap BEFORE the new access token is used; a lost race stops here
 *   7 fetch the report through the read-only guard  8 convert (qboTrialBalance: 25 reasons to refuse, never repaired)  9 check the report's own period
 *   10 hash the raw response, the canonical file and the normalised result  11 reserve, store and register the upload as the person
 *   12 record the provenance (append-only).
 * Never in an outcome, a log field or an error: a token, an envelope, a response body.
 */
import { parseQboTrialBalanceReport, toCanonicalCsv, type QboTbRefusalCode } from "./qboTrialBalance.ts";
import { connectionBinding, type EnvelopeBinding } from "./qboTokenEnvelope.ts";
import type { TokenResult } from "./qboTokenClient.ts";
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_CHARS = 5_000_000;

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
export interface ProvenanceRecord {
  companyId: string; uploadId: string; connectionId: string; actorUserId: string; realmId: string; environment: QboEnvironment; startDate: string; endDate: string;
  accountingMethod: string | null; minorVersion: number | null; currency: string; accountCount: number; rawSha256: string; canonicalSha256: string; resultSha256: string;
}

export interface PullDeps {
  authenticate(): Promise<string | null>;
  /** workspace_authority_basis(user, company, 'prepare_trial_balance') is not null. */
  canPrepare(userId: string, companyId: string): Promise<boolean>;
  findConnection(companyId: string, realmId: string, environment: QboEnvironment): Promise<StoredConnection | null>;
  openRefreshToken(envelope: string, binding: EnvelopeBinding): Promise<string | null>;
  refresh(environment: QboEnvironment, refreshToken: string): Promise<TokenResult>;
  sealRefreshToken(refreshToken: string, binding: EnvelopeBinding): Promise<string>;
  /** Compare-and-swap: true only if `expected` was still the stored envelope. */
  rotate(connectionId: string, expected: string, next: string, refreshExpiresAt: string, hardExpiresAt: string | null): Promise<boolean>;
  markReconnectNeeded(connectionId: string): Promise<void>;
  fetchReport(environment: QboEnvironment, realmId: string, accessToken: string, p: { startDate: string; endDate: string; accountingMethod?: "Accrual" | "Cash" }): Promise<{ status: number; text: string }>;
  sha256Hex(data: string | Uint8Array): Promise<string>;
  summarise(csv: Uint8Array, currency: string, periodYear: number): Promise<{ accountCount: number; resultSha256: string }>;
  reserve(companyId: string, fileName: string): Promise<{ ok: true; reservationId: string; objectPath: string } | { ok: false; reason: "forbidden" | "failed" }>;
  putObject(path: string, bytes: Uint8Array): Promise<boolean>;
  removeObject(path: string): Promise<void>;
  register(reservationId: string, fileSize: number, periodYear: number, periodId: string | null, engagementId: string | null): Promise<{ outcome: string; uploadId: string | null }>;
  recordPull(r: ProvenanceRecord): Promise<void>;
  minorVersion: number | null;
}

export type PullResult =
  | { status: 200; outcome: "imported"; uploadId: string; currency: string; accountCount: number; startDate: string; endDate: string }
  | { status: 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503; outcome: string; code?: QboTbRefusalCode; message?: string; uploadId?: string };

const fail = (status: 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503, outcome: string, extra: { code?: QboTbRefusalCode; message?: string; uploadId?: string } = {}): PullResult => ({ status, outcome, ...extra });

export async function runQboPull(deps: PullDeps, req: PullRequest): Promise<PullResult> {
  const userId = await deps.authenticate();
  if (!userId) return fail(401, "unauthenticated");
  if (!(await deps.canPrepare(userId, req.companyId))) return fail(403, "forbidden");

  const conn = await deps.findConnection(req.companyId, req.realmId, req.environment);
  if (!conn) return fail(404, "not_connected");
  if (conn.status !== "active" || !conn.envelope) return fail(409, "reconnect_needed");
  const binding = connectionBinding(req.companyId, req.realmId, req.environment);
  const stored = await deps.openRefreshToken(conn.envelope, binding);
  if (!stored) return fail(500, "token_unreadable");

  const refreshed = await deps.refresh(req.environment, stored);
  if (!refreshed.ok) {
    if (refreshed.reason === "invalid_grant") { await deps.markReconnectNeeded(conn.id); return fail(409, "reconnect_needed"); }
    return refreshed.reason === "unavailable" ? fail(503, "quickbooks_unavailable") : fail(502, "quickbooks_rejected");
  }
  // Intuit rolls the refresh token over: the newest one is stored BEFORE the new access token is used. A lost race (another pull rotated first) stops here.
  const next = await deps.sealRefreshToken(refreshed.tokens.refreshToken, binding);
  if (!(await deps.rotate(conn.id, conn.envelope, next, refreshed.tokens.refreshExpiresAt, refreshed.tokens.hardExpiresAt))) return fail(409, "busy");

  const res = await deps.fetchReport(req.environment, req.realmId, refreshed.tokens.accessToken, { startDate: req.startDate, endDate: req.endDate, accountingMethod: req.accountingMethod });
  if (res.status === 429) return fail(429, "rate_limited");
  if (res.status >= 500) return fail(503, "quickbooks_unavailable");
  if (res.status !== 200) return fail(502, "report_failed");
  if (res.text.length > MAX_REPORT_CHARS) return fail(502, "report_too_large");
  let json: unknown;
  try { json = JSON.parse(res.text); } catch { return fail(502, "report_unreadable"); }

  const parsed = parseQboTrialBalanceReport(json);
  if (!parsed.ok) return fail(422, "report_refused", { code: parsed.code, message: parsed.message });
  const report = parsed.report;
  if (report.startPeriod !== req.startDate || report.endPeriod !== req.endDate) {
    return fail(422, "period_mismatch", { message: `QuickBooks returned ${report.startPeriod} to ${report.endPeriod}, not the ${req.startDate} to ${req.endDate} that was asked for.` });
  }

  const csv = new TextEncoder().encode(toCanonicalCsv(report));
  const [rawSha256, canonicalSha256, summary] = await Promise.all([deps.sha256Hex(res.text), deps.sha256Hex(csv), deps.summarise(csv, report.currency, req.periodYear)]);

  const fileName = `quickbooks-${req.environment === "sandbox" ? "sandbox-" : ""}${req.realmId}-${req.endDate}.csv`;
  const reserved = await deps.reserve(req.companyId, fileName);
  if (!reserved.ok) return reserved.reason === "forbidden" ? fail(403, "forbidden") : fail(500, "reserve_failed");
  if (!(await deps.putObject(reserved.objectPath, csv))) return fail(500, "store_failed");
  const registered = await deps.register(reserved.reservationId, csv.byteLength, req.periodYear, req.periodId, req.engagementId);
  if ((registered.outcome !== "registered" && registered.outcome !== "already_registered") || !registered.uploadId) {
    await deps.removeObject(reserved.objectPath).catch(() => undefined);
    if (registered.outcome === "active_upload_exists") return fail(409, "active_upload_exists");
    if (registered.outcome === "forbidden") return fail(403, "forbidden");
    return fail(500, "register_failed");
  }

  try {
    await deps.recordPull({
      companyId: req.companyId, uploadId: registered.uploadId, connectionId: conn.id, actorUserId: userId, realmId: req.realmId, environment: req.environment,
      startDate: req.startDate, endDate: req.endDate, accountingMethod: req.accountingMethod ?? null, minorVersion: deps.minorVersion, currency: report.currency,
      accountCount: summary.accountCount, rawSha256, canonicalSha256, resultSha256: summary.resultSha256,
    });
  } catch {
    // The upload exists but its provenance could not be written: say so plainly rather than pretend it is complete.
    return fail(500, "provenance_failed", { uploadId: registered.uploadId });
  }
  return { status: 200, outcome: "imported", uploadId: registered.uploadId, currency: report.currency, accountCount: summary.accountCount, startDate: req.startDate, endDate: req.endDate };
}
