/**
 * resolveReturningUserRoute — the pure decision behind Dashboard.tsx's returning-user routing.
 *
 * Pure function: given the open engagements and the companies with none, returns exactly one of
 * four outcomes. No async, no DB access, no React — same discipline as deriveWorkspaceState.ts, so
 * the "never guess among multiple engagements" invariant is covered by fast, direct unit tests
 * instead of depending on effects firing inside a rendered component.
 *
 * Deliberately structural (not importing ActiveEngagementEntry/WorkspaceCompany) so this module has
 * no dependency on hooks or Supabase-shaped rows — only the two fields the decision actually needs.
 */

export interface ReturningUserEngagementEntry {
  companyId: string;
  periodYear: number;
}

export interface ReturningUserCompany {
  id: string;
}

export type ReturningUserRoute<
  TEntry extends ReturningUserEngagementEntry,
  TCompany extends ReturningUserCompany,
  TShared extends ReturningUserCompany = ReturningUserCompany,
> =
  /** Exactly one open engagement — resume its authoritative overview directly. */
  | { kind: "resume"; entry: TEntry }
  /** No open engagement anywhere, exactly one company — auto-navigate in (ServiceLaunchpad shows there). */
  | { kind: "start_single_company"; company: TCompany }
  /** More than one open engagement, OR no open engagement and more than one company — never guess. */
  | { kind: "chooser" }
  /** No company of their own and exactly one workspace shared with them (an explicit Prepare grant) — open its Prepare stage. */
  | { kind: "open_shared"; workspace: TShared }
  /** No companies at all, and nothing shared. */
  | { kind: "first_run" };

export function decideReturningUserRoute<
  TEntry extends ReturningUserEngagementEntry,
  TCompany extends ReturningUserCompany,
  TShared extends ReturningUserCompany = ReturningUserCompany,
>(entries: TEntry[], companiesWithoutEngagement: TCompany[], shared: TShared[] = []): ReturningUserRoute<TEntry, TCompany, TShared> {
  if (entries.length === 0 && companiesWithoutEngagement.length === 0) {
    // Workspaces shared through an explicit grant (PR #32) are reachable; one opens directly, several are a choice.
    if (shared.length === 1) return { kind: "open_shared", workspace: shared[0] };
    return shared.length === 0 ? { kind: "first_run" } : { kind: "chooser" };
  }

  // Exactly one open engagement resumes directly, regardless of how many OTHER companies have no
  // open engagement — a single unambiguous active engagement is never turned into a guess by the
  // mere existence of dormant companies.
  if (entries.length === 1) {
    return { kind: "resume", entry: entries[0] };
  }

  if (entries.length === 0 && companiesWithoutEngagement.length === 1 && shared.length === 0) {
    return { kind: "start_single_company", company: companiesWithoutEngagement[0] };
  }

  // Every remaining shape (>1 engagement, or 0 engagements + >1 companies, or own and shared workspaces) is ambiguous.
  return { kind: "chooser" };
}

/**
 * applyForceHub — the logo's own routing contract, layered on top of decideReturningUserRoute
 * without changing it. Sign-in landing (forceHub=false) keeps auto-resuming an unambiguous single
 * engagement — that is the correct, low-friction default. But the CFOClose logo, clicked from
 * INSIDE a workspace as an explicit "take me to the hub" escape, must never silently re-land the
 * user back in the exact workspace they just tried to leave: a "resume"/"start_single_company"
 * outcome is downgraded to "chooser" so the hub actually renders, even when it will only ever list
 * one entry. "first_run" (nothing to choose from) and an already-ambiguous "chooser" are unaffected
 * — there is nothing a forced hub view could usefully add to either.
 */
export function applyForceHub<
  TEntry extends ReturningUserEngagementEntry,
  TCompany extends ReturningUserCompany,
  TShared extends ReturningUserCompany = ReturningUserCompany,
>(route: ReturningUserRoute<TEntry, TCompany, TShared>, forceHub: boolean): ReturningUserRoute<TEntry, TCompany, TShared> {
  if (!forceHub) return route;
  if (route.kind === "resume" || route.kind === "start_single_company" || route.kind === "open_shared") {
    return { kind: "chooser" };
  }
  return route;
}
