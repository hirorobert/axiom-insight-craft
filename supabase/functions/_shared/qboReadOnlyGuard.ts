/**
 * qboReadOnlyGuard — the ONE place that may talk to Intuit (docs/architecture/QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md §4.2).
 *
 * The OAuth permission Intuit grants for the Accounting scope is not (as far as the pages read show) a read-only one, so
 * read-only is enforced HERE, in our own code, by an exact allow-list. Every request the connector makes goes through
 * `guardedQboFetch`; anything not on the list is refused BEFORE a socket is opened:
 *
 *   report   GET  https://{quickbooks|sandbox-quickbooks}.api.intuit.com/v3/company/<digits>/reports/TrialBalance
 *                 query keys only: start_date, end_date (YYYY-MM-DD), accounting_method (Cash|Accrual), minorversion (digits)
 *   token    POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer      (authorisation-code exchange and refresh; no query)
 *
 * Nothing else: no other report, no query/entity endpoint, no write method, no other host (look-alikes, userinfo, ports, plain
 * http, fragments, encoded or doubled path segments are all refused), no redirect following. Revocation on disconnect is NOT on
 * the list yet: its endpoint has not been verified against Intuit's documentation, and an unverified endpoint is not added.
 * Every call is abandoned after a fixed time (QBO_TIMEOUTS_MS), so a refresh can never outlast the refresh lease that protects it.
 *
 * Pure apart from the injected fetch; no credentials are read, stored or logged here.
 */

export type QboEnvironment = "production" | "sandbox";

export const QBO_API_HOSTS: Readonly<Record<QboEnvironment, string>> = Object.freeze({
  production: "quickbooks.api.intuit.com",
  sandbox: "sandbox-quickbooks.api.intuit.com",
});
export const QBO_TOKEN_HOST = "oauth.platform.intuit.com";
export const QBO_TOKEN_PATH = "/oauth2/v1/tokens/bearer";
const QBO_REVOKE_HOST = "developer.api.intuit.com";
const QBO_REVOKE_PATH = "/v2/oauth2/tokens/revoke";
export const QBO_REVOKE_URL = `https://${QBO_REVOKE_HOST}${QBO_REVOKE_PATH}`;

/** The only reports the connector may read. TrialBalanceFR (France) is deliberately absent until a French sample is recorded. */
export const QBO_ALLOWED_REPORTS: readonly string[] = Object.freeze(["TrialBalance"]);

const REPORT_QUERY: Readonly<Record<string, RegExp>> = Object.freeze({
  start_date: /^\d{4}-\d{2}-\d{2}$/,
  end_date: /^\d{4}-\d{2}-\d{2}$/,
  accounting_method: /^(Cash|Accrual)$/,
  minorversion: /^\d{1,3}$/,
});

export type QboRequestKind = "report" | "token" | "preferences" | "revoke";
export type QboRequestVerdict = { ok: true; kind: QboRequestKind; environment: QboEnvironment | null } | { ok: false; reason: string };

const no = (reason: string): QboRequestVerdict => ({ ok: false, reason });

export function classifyQboRequest(req: { method: string; url: string }): QboRequestVerdict {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return no("the address is not a valid URL");
  }
  if (u.protocol !== "https:") return no("only https is allowed");
  if (u.username !== "" || u.password !== "") return no("credentials in the address are not allowed");
  if (u.port !== "") return no("a port is not allowed");
  if (u.hash !== "") return no("a fragment is not allowed");

  if (u.hostname === QBO_REVOKE_HOST) {
    return req.method === "POST" && u.pathname === QBO_REVOKE_PATH && !u.search
      ? { ok: true, kind: "revoke", environment: null } : no("only the fixed OAuth revocation POST is allowed");
  }

  if (u.hostname === QBO_TOKEN_HOST) {
    if (req.method !== "POST") return no("the token endpoint is called with POST only");
    if (u.pathname !== QBO_TOKEN_PATH || u.search !== "") return no("only the token path, without a query, is allowed");
    return { ok: true, kind: "token", environment: null };
  }

  const environment = (Object.keys(QBO_API_HOSTS) as QboEnvironment[]).find((e) => QBO_API_HOSTS[e] === u.hostname);
  if (!environment) return no(`the host "${u.hostname}" is not allowed`);
  if (req.method !== "GET") return no("QuickBooks data is read with GET only");
  const preferences = /^\/v3\/company\/\d{1,20}\/preferences$/.test(u.pathname);
  if (preferences) {
    const entries = [...u.searchParams];
    if (entries.length > 1 || entries.some(([k, v]) => k !== "minorversion" || !/^\d{1,3}$/.test(v))) return no("only minorversion is allowed for Preferences");
    return { ok: true, kind: "preferences", environment };
  }
  const m = /^\/v3\/company\/(\d{1,20})\/reports\/([A-Za-z]+)$/.exec(u.pathname);
  if (!m) return no("only /v3/company/<id>/reports/<report> is allowed");
  if (!QBO_ALLOWED_REPORTS.includes(m[2])) return no(`the report "${m[2]}" is not allowed`);
  const seen = new Set<string>();
  for (const [key, value] of u.searchParams) {
    const rule = REPORT_QUERY[key];
    if (!rule) return no(`the query key "${key}" is not allowed`);
    if (seen.has(key)) return no(`the query key "${key}" is repeated`);
    seen.add(key);
    if (!rule.test(value)) return no(`the value of "${key}" is not allowed`);
  }
  return { ok: true, kind: "report", environment };
}

export class QboGuardRefusal extends Error {
  constructor(readonly reason: string) {
    super(`QuickBooks request refused by the read-only guard: ${reason}`);
    this.name = "QboGuardRefusal";
  }
}

// ── the addresses the connector uses (they live here so that no other code names an Intuit host) ─────────────────────────────

export const QBO_TOKEN_URL = `https://${QBO_TOKEN_HOST}${QBO_TOKEN_PATH}`;
export const QBO_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export function qboPreferencesUrl(environment: QboEnvironment, realmId: string, minorVersion: number): string {
  const url = `https://${QBO_API_HOSTS[environment]}/v3/company/${realmId}/preferences?minorversion=${minorVersion}`;
  const verdict = classifyQboRequest({ method: "GET", url });
  if (!verdict.ok) throw new QboGuardRefusal(verdict.reason);
  return url;
}
// The authorisation page is a BROWSER redirect target. The server never fetches it, so it is not on the request allow-list above.
const QBO_AUTHORIZE_BASE = "https://appcenter.intuit.com/connect/oauth2";

/** The browser address that starts authorisation: the Accounting scope only, the state we generated, the redirect address registered for the app. */
export function qboAuthorizeUrl(a: { clientId: string; redirectUri: string; state: string }): string {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(a.clientId)) throw new QboGuardRefusal("the client id is malformed");
  if (!/^https:\/\/[^\s?#]+$/.test(a.redirectUri)) throw new QboGuardRefusal("the redirect address must be an https address without a query or fragment");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(a.state)) throw new QboGuardRefusal("the state is malformed");
  const q = new URLSearchParams({ client_id: a.clientId, response_type: "code", scope: QBO_ACCOUNTING_SCOPE, redirect_uri: a.redirectUri, state: a.state });
  return `${QBO_AUTHORIZE_BASE}?${q.toString()}`;
}

/** The address of one Trial Balance report. Always both dates (a lone end date is ignored by QuickBooks). Refused unless the guard would allow it. */
export function qboReportUrl(a: { environment: QboEnvironment; realmId: string; startDate: string; endDate: string; accountingMethod?: "Accrual" | "Cash"; minorVersion?: number }): string {
  const q = new URLSearchParams({ start_date: a.startDate, end_date: a.endDate });
  if (a.accountingMethod) q.set("accounting_method", a.accountingMethod);
  if (a.minorVersion !== undefined) q.set("minorversion", String(a.minorVersion));
  const url = `https://${QBO_API_HOSTS[a.environment]}/v3/company/${a.realmId}/reports/TrialBalance?${q.toString()}`;
  const verdict = classifyQboRequest({ method: "GET", url });
  if (!verdict.ok) throw new QboGuardRefusal(verdict.reason);
  return url;
}

export interface GuardedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

/**
 * How long a call to Intuit may take, response body included, before it is abandoned (the caller sees a network failure). The token call is the one
 * that matters: it runs under the 90-second refresh lease (qboPull.REFRESH_LEASE_SECONDS), and must end well inside it so that the lease can never
 * lapse while this import is still waiting for Intuit, which would let a second import present the same refresh token.
 */
export const QBO_TIMEOUTS_MS: Readonly<Record<QboRequestKind, number>> = Object.freeze({ token: 30_000, report: 60_000, preferences: 15_000, revoke: 15_000 });

/** The only way the connector calls Intuit. Refuses before any network call; never follows a redirect; never waits longer than its timeout. */
export function createGuardedQboFetch(fetchImpl: FetchLike, timeoutsMs: Readonly<Record<QboRequestKind, number>> = QBO_TIMEOUTS_MS) {
  return async function guardedQboFetch(req: GuardedRequest): Promise<Response> {
    const verdict = classifyQboRequest(req);
    if (!verdict.ok) throw new QboGuardRefusal(verdict.reason);
    if ((verdict.kind === "report" || verdict.kind === "preferences") && req.body !== undefined) throw new QboGuardRefusal("a report request has no body");
    return fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "error", signal: AbortSignal.timeout(timeoutsMs[verdict.kind]) });
  };
}
