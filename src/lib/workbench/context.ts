/**
 * Workbench context: company, period and selected report version. Pure.
 *
 * Company and period are part of every workspace route (/workspace/:companyId/:periodYear). The selected report version
 * travels as the `v` query parameter on every workbench link, so navigation never silently changes what is shown.
 * Switching any part of the context is an explicit action (ContextBar); a link never switches it as a side effect.
 */

export interface WorkbenchContext {
  readonly companyId: string;
  readonly periodYear: number;
  /** A positive integer report version, or null when none is selected (the latest is then shown by each page). */
  readonly reportVersion: number | null;
}

/** Strict parse of the `v` parameter: a positive integer, else null (never a guess). */
export function parseReportVersion(search: string): number | null {
  const raw = new URLSearchParams(search).get("v");
  if (raw === null || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  return Number(raw);
}

/** The href with the context's report version carried on it (an existing `v` on the target is replaced). */
export function withContext(href: string, ctx: Pick<WorkbenchContext, "reportVersion">): string {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  if (ctx.reportVersion === null) params.delete("v");
  else params.set("v", String(ctx.reportVersion));
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/** A stable key for the context: responses are bound to it and discarded when it changes (see requestSequence). */
export function contextKey(ctx: WorkbenchContext): string {
  return `${ctx.companyId}|${ctx.periodYear}|${ctx.reportVersion ?? "latest"}`;
}

/** The announcement made when the context changes (polite live region). */
export function contextChangeAnnouncement(before: WorkbenchContext, after: WorkbenchContext): string | null {
  if (before.companyId !== after.companyId) return "Now viewing another company.";
  if (before.periodYear !== after.periodYear) return `Now viewing FY${after.periodYear}.`;
  if (before.reportVersion !== after.reportVersion) {
    return after.reportVersion === null ? "Now viewing the latest report version." : `Now viewing report version ${after.reportVersion}.`;
  }
  return null;
}
