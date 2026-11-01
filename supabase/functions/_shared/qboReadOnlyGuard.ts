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

/** The only reports the connector may read. TrialBalanceFR (France) is deliberately absent until a French sample is recorded. */
export const QBO_ALLOWED_REPORTS: readonly string[] = Object.freeze(["TrialBalance"]);

const REPORT_QUERY: Readonly<Record<string, RegExp>> = Object.freeze({
  start_date: /^\d{4}-\d{2}-\d{2}$/,
  end_date: /^\d{4}-\d{2}-\d{2}$/,
  accounting_method: /^(Cash|Accrual)$/,
  minorversion: /^\d{1,3}$/,
});

export type QboRequestKind = "report" | "token";
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

  if (u.hostname === QBO_TOKEN_HOST) {
    if (req.method !== "POST") return no("the token endpoint is called with POST only");
    if (u.pathname !== QBO_TOKEN_PATH || u.search !== "") return no("only the token path, without a query, is allowed");
    return { ok: true, kind: "token", environment: null };
  }

  const environment = (Object.keys(QBO_API_HOSTS) as QboEnvironment[]).find((e) => QBO_API_HOSTS[e] === u.hostname);
  if (!environment) return no(`the host "${u.hostname}" is not allowed`);
  if (req.method !== "GET") return no("QuickBooks data is read with GET only");
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

export interface GuardedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; redirect: "error" }) => Promise<Response>;

/** The only way the connector calls Intuit. Refuses before any network call; never follows a redirect. */
export function createGuardedQboFetch(fetchImpl: FetchLike) {
  return async function guardedQboFetch(req: GuardedRequest): Promise<Response> {
    const verdict = classifyQboRequest(req);
    if (!verdict.ok) throw new QboGuardRefusal(verdict.reason);
    if (verdict.kind === "report" && req.body !== undefined) throw new QboGuardRefusal("a report request has no body");
    return fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "error" });
  };
}
