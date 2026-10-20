/**
 * accountHome — the ONLY browser path to the account home's routing read (get_account_home, 20261117100000).
 *
 * Every routing decision the home makes — resume the one engagement, open the one company, open the one shared
 * workspace, first run, or show the choice — is taken from the server's EXACT counts, never from a client list that
 * PostgREST could have truncated at its row cap. The lists are bounded samples with their true totals (complete or not),
 * used only to name what a single-item decision opens and to show the first few rows with "and N more".
 * A failed or malformed read is "unavailable": the home says so and offers Try again — it never routes on a guess.
 */
import { CUSTOMER_HIDDEN_CAPABILITIES } from "@/lib/workspace/moduleAvailability";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";
import type { UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export interface HomeEngagement { engagementId: string; companyId: string; companyName: string; periodYear: number; openedAt: string }
export interface Counted<T> { total: number; rows: T[]; complete: boolean }
export interface AccountHome {
  engagements: Counted<HomeEngagement>;
  withheld: Counted<UnavailableServiceEngagement>;
  companiesWithoutEngagement: Counted<WorkspaceCompany>;
  shared: Counted<SharedWorkspace>;
}
export const HOME_SAMPLE = 50;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function counted<T>(v: unknown, parse: (r: Record<string, unknown>) => T | null): Counted<T> | null {
  const o = obj(v);
  if (typeof o.total !== "number" || !Array.isArray(o.rows)) return null;
  const rows = o.rows.map((r) => parse(obj(r)));
  if (rows.some((r) => r === null)) return null;
  return { total: o.total, rows: rows as T[], complete: rows.length === o.total };
}

/** Reads the home. Strict: any malformed part makes the whole read unavailable (never a partial picture). */
export async function fetchAccountHome(rpc: Rpc, limit = HOME_SAMPLE): Promise<AccountHome | null> {
  const { data, error } = await rpc("get_account_home", { p_withheld: [...CUSTOMER_HIDDEN_CAPABILITIES], p_limit: limit });
  const d = obj(data);
  if (error || d.outcome !== "ok") return null;
  const engagements = counted<HomeEngagement>(d.engagements, (r) => {
    const id = str(r.engagement_id), c = str(r.company_id), n = str(r.company_name), o = str(r.opened_at);
    return id && c && n && o && typeof r.period_year === "number" ? { engagementId: id, companyId: c, companyName: n, periodYear: r.period_year, openedAt: o } : null;
  });
  const withheld = counted<UnavailableServiceEngagement>(d.withheld, (r) => {
    const id = str(r.engagement_id), c = str(r.company_id), n = str(r.company_name);
    return id && c && n && typeof r.period_year === "number" ? { engagementId: id, companyId: c, companyName: n, periodYear: r.period_year } : null;
  });
  const companiesWithoutEngagement = counted<WorkspaceCompany>(d.companies_without_engagement, (r) =>
    (str(r.id) && str(r.name) ? r as unknown as WorkspaceCompany : null));
  const shared = counted<SharedWorkspace>(d.shared, (r) => {
    const id = str(r.id);
    return id ? { id, name: str(r.name) ?? "", capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((x): x is string => typeof x === "string") : [],
      fiscal_year_end: str(r.fiscal_year_end), reporting_framework: str(r.reporting_framework), currency: str(r.currency), created_at: str(r.created_at) } : null;
  });
  if (!engagements || !withheld || !companiesWithoutEngagement || !shared) return null;
  return { engagements, withheld, companiesWithoutEngagement, shared };
}

export type AccountHomeRoute =
  | { kind: "resume"; entry: HomeEngagement }
  | { kind: "start_single_company"; company: WorkspaceCompany }
  | { kind: "open_shared"; workspace: SharedWorkspace }
  | { kind: "chooser" }
  | { kind: "first_run" };

/**
 * The returning user's route, from EXACT totals (resolveReturningUserRoute's rules, unchanged): exactly one open
 * engagement resumes it; no engagement and exactly one company opens that company; nothing of one's own and exactly one
 * shared workspace opens it; nothing at all is the first run; everything else is a choice. A single-item route needs its
 * row (the sample always holds it when the total is 1); without it, the home shows the choice — never a guess.
 */
export function decideAccountHomeRoute(h: AccountHome, forceHub = false): AccountHomeRoute {
  const e = h.engagements.total, c = h.companiesWithoutEngagement.total, s = h.shared.total, w = h.withheld.total;
  let route: AccountHomeRoute;
  if (e === 0 && c === 0) {
    if (w > 0 && s === 0) route = { kind: "chooser" };
    else if (s === 1 && h.shared.rows[0]) route = { kind: "open_shared", workspace: h.shared.rows[0] };
    else route = s === 0 ? { kind: "first_run" } : { kind: "chooser" };
  } else if (e === 1 && h.engagements.rows[0]) route = { kind: "resume", entry: h.engagements.rows[0] };
  else if (e === 0 && c === 1 && s === 0 && h.companiesWithoutEngagement.rows[0]) route = { kind: "start_single_company", company: h.companiesWithoutEngagement.rows[0] };
  else route = { kind: "chooser" };
  // The workspace logo's explicit "take me to the hub" never re-lands in the workspace just left.
  if (forceHub && (route.kind === "resume" || route.kind === "start_single_company" || route.kind === "open_shared")) return { kind: "chooser" };
  return route;
}
