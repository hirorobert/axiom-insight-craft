/**
 * portfolioClient — the ONLY browser path to the engagements portfolio (list_portfolio_engagements, 20261117100000).
 *
 * The server authorises (the platform's workspace-access rule), filters, counts, orders and pages (keyset). This module
 * only sends the query and reads the answer strictly. Pages form a LIVE view, not a snapshot: each answer carries a
 * view_token over the caller's visible companies; a later page whose token differs from the first page's means
 * something visible changed, and the list must be refreshed from the first page (never silently re-shuffled).
 */
export const PORTFOLIO_STATUSES = ["needs_decision", "blocked", "processing_failed", "needs_recheck", "processing", "no_trial_balance", "ready"] as const;
export type PortfolioStatus = (typeof PORTFOLIO_STATUSES)[number];
export const PORTFOLIO_PURPOSES = ["client", "test", "training", "not_stated"] as const;
export type PortfolioPurpose = (typeof PORTFOLIO_PURPOSES)[number];
export type PortfolioSort = "entity" | "period" | "opened";
export const PORTFOLIO_PAGE_SIZE = 25;

export interface PortfolioQuery {
  search: string;
  statuses: PortfolioStatus[];
  purposes: PortfolioPurpose[];
  periodYear: number | null;
  sort: PortfolioSort;
}
export interface PortfolioRow {
  engagementId: string;
  companyId: string;
  companyName: string;
  companyCode: string | null;
  companyTin: string | null;
  periodYear: number;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  purpose: PortfolioPurpose;
  status: PortfolioStatus;
  upload: { fileName: string; uploadedAt: string; uploadedBy: string | null } | null;
}
export type PortfolioCursor = Record<string, unknown>;
export type PortfolioPage =
  | { kind: "ok"; rows: PortfolioRow[]; total: number; statusCounts: Partial<Record<PortfolioStatus, number>>; nextCursor: PortfolioCursor | null; viewToken: string }
  | { kind: "refused"; code: string }
  | { kind: "unavailable" };

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const isStatus = (v: unknown): v is PortfolioStatus => typeof v === "string" && (PORTFOLIO_STATUSES as readonly string[]).includes(v);
const isPurpose = (v: unknown): v is PortfolioPurpose => typeof v === "string" && (PORTFOLIO_PURPOSES as readonly string[]).includes(v);

function parseRow(v: unknown): PortfolioRow | null {
  const r = obj(v);
  const id = str(r.engagement_id), company = str(r.company_id), name = str(r.company_name);
  if (!id || !company || !name || typeof r.period_year !== "number" || !isStatus(r.status) || !isPurpose(r.purpose)) return null;
  const u = r.upload === null ? null : obj(r.upload);
  return {
    engagementId: id, companyId: company, companyName: name, companyCode: str(r.company_code), companyTin: str(r.company_tin),
    periodYear: r.period_year, periodStart: str(r.period_start), periodEnd: str(r.period_end), currency: str(r.currency),
    purpose: r.purpose, status: r.status,
    upload: u && str(u.file_name) && str(u.uploaded_at) ? { fileName: str(u.file_name)!, uploadedAt: str(u.uploaded_at)!, uploadedBy: str(u.uploaded_by) } : null,
  };
}

export async function fetchPortfolioPage(rpc: Rpc, q: PortfolioQuery, cursor: PortfolioCursor | null, limit = PORTFOLIO_PAGE_SIZE): Promise<PortfolioPage> {
  const { data, error } = await rpc("list_portfolio_engagements", {
    p_search: q.search.trim() || null,
    p_statuses: q.statuses.length ? q.statuses : null,
    p_purposes: q.purposes.length ? q.purposes : null,
    p_period_year: q.periodYear,
    p_sort: q.sort,
    p_limit: limit,
    p_cursor: cursor,
  });
  if (error) return { kind: "unavailable" };
  const d = obj(data);
  if (d.outcome !== "ok") return typeof d.code === "string" ? { kind: "refused", code: d.code } : { kind: "unavailable" };
  const rows = Array.isArray(d.rows) ? d.rows.map(parseRow) : [];
  if (rows.some((r) => r === null) || typeof d.total !== "number" || !str(d.view_token)) return { kind: "unavailable" };
  const counts: Partial<Record<PortfolioStatus, number>> = {};
  for (const [k, n] of Object.entries(obj(d.status_counts))) if (isStatus(k) && typeof n === "number") counts[k] = n;
  return { kind: "ok", rows: rows as PortfolioRow[], total: d.total, statusCounts: counts,
    nextCursor: d.next_cursor && typeof d.next_cursor === "object" ? d.next_cursor as PortfolioCursor : null, viewToken: str(d.view_token)! };
}

/** The status in words, its tone and the one action a row offers (where it leads is decided by the workspace). */
export const PORTFOLIO_STATUS_VIEW: Readonly<Record<PortfolioStatus, { label: string; tone: "danger" | "warning" | "neutral" | "success" | "progress"; action: string; destination: "review" | "overview" }>> = {
  needs_decision: { label: "Needs your decision", tone: "warning", action: "Make decisions", destination: "review" },
  blocked: { label: "Blocked", tone: "danger", action: "Fix trial balance", destination: "review" },
  processing_failed: { label: "Check stopped", tone: "danger", action: "See what stopped", destination: "review" },
  needs_recheck: { label: "Needs re-check", tone: "warning", action: "Check again", destination: "review" },
  processing: { label: "Checking", tone: "progress", action: "View progress", destination: "review" },
  no_trial_balance: { label: "No trial balance", tone: "neutral", action: "Upload trial balance", destination: "review" },
  ready: { label: "Accepted", tone: "success", action: "Open", destination: "overview" },
};
export const PORTFOLIO_PURPOSE_LABEL: Readonly<Record<PortfolioPurpose, string>> = {
  client: "Client work", test: "Test", training: "Training", not_stated: "Purpose not stated",
};

/** The engagement's own page for the row's action. */
export function portfolioDestination(row: PortfolioRow): string {
  const base = `/workspace/${row.companyId}/${row.periodYear}`;
  return PORTFOLIO_STATUS_VIEW[row.status].destination === "overview" ? base : `${base}/trial-balance/review`;
}
