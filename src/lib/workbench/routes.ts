/**
 * Workbench information architecture: five groups, their pages, canonical routes and legacy aliases. Pure.
 *
 * The workbench never decides what a person may open. It regroups the navigation the existing model already derived
 * (deriveWorkspaceNavigation: engagement scope, workspace access and customer visibility from moduleAvailability), so a
 * group appears only when (a) the existing model offers its stage and (b) at least one of its pages is released. Groups
 * whose pages are not released are absent, not disabled. Withheld modules therefore never appear.
 *
 * One canonical destination per task: every page has exactly one route; legacy segments redirect to it.
 */
import type { NavItem } from "@/lib/workspace/navigation";
import type { WorkspaceMission } from "@/lib/workspace/types";
import { isStageCustomerVisible } from "@/lib/workspace/moduleAvailability";

export type WorkbenchGroupId = "overview" | "trial-balance" | "close-review" | "financial-statements" | "signoff-exports";
export type WorkbenchPageId =
  | "overview"
  | "tb-intake"
  | "tb-review"
  | "close-findings"
  | "close-adjustments"
  | "fs-statements"
  | "fs-notes"
  | "fs-schedules"
  | "fs-comparatives"
  | "signoff"
  | "exports";

export interface WorkbenchPage {
  readonly id: WorkbenchPageId;
  readonly label: string;
  /** Route segment below /workspace/:companyId/:periodYear ("" for the overview). */
  readonly segment: string;
}

export interface WorkbenchGroup {
  readonly id: WorkbenchGroupId;
  readonly label: string;
  /** The existing workspace stage whose navigation item gates this group (null: always offered). */
  readonly stage: WorkspaceMission | null;
  readonly pages: readonly WorkbenchPage[];
}

export const WORKBENCH_GROUPS: readonly WorkbenchGroup[] = Object.freeze([
  { id: "overview", label: "Overview", stage: null, pages: [{ id: "overview", label: "Overview", segment: "" }] },
  {
    id: "trial-balance",
    label: "Trial Balance",
    stage: "prepare",
    pages: [
      { id: "tb-intake", label: "Intake", segment: "trial-balance/intake" },
      { id: "tb-review", label: "Account review", segment: "trial-balance/review" },
    ],
  },
  {
    id: "close-review",
    label: "Close Review",
    stage: "prepare",
    pages: [
      { id: "close-findings", label: "Findings", segment: "close/findings" },
      { id: "close-adjustments", label: "Adjustments", segment: "close/adjustments" },
    ],
  },
  {
    id: "financial-statements",
    label: "Financial Statements",
    stage: "statements",
    pages: [
      { id: "fs-statements", label: "Statements", segment: "statements" },
      { id: "fs-notes", label: "Notes", segment: "statements/notes" },
      { id: "fs-schedules", label: "Schedules", segment: "statements/schedules" },
      { id: "fs-comparatives", label: "Comparatives", segment: "statements/comparatives" },
    ],
  },
  {
    id: "signoff-exports",
    label: "Sign-off & Exports",
    stage: "statements",
    pages: [
      { id: "signoff", label: "Sign-off", segment: "signoff" },
      { id: "exports", label: "Exports", segment: "signoff/exports" },
    ],
  },
]);

/**
 * Pages whose implementation is released in this codebase. Adding a page here is the reviewed step that makes it (and
 * its group) reachable; the increments that build Findings, Adjustments, Statements, Notes, Schedules, Comparatives,
 * Sign-off and Exports add theirs.
 */
export const RELEASED_WORKBENCH_PAGES: ReadonlySet<WorkbenchPageId> = new Set<WorkbenchPageId>(["overview", "tb-intake", "tb-review"]);

/**
 * Whether the reporting pages (Financial Statements; Sign-off & Exports) are part of the BUILD at all. A literal, so the
 * bundler drops the unreleased chunk entirely (not merely hides it); it must equal "every reporting page is released"
 * (routes.test.ts). Releasing the reporting pages changes both, in one reviewed commit.
 */
export const REPORTING_PAGES_SHIPPED = false;

/** Legacy workspace route segments and the one canonical workbench segment each resolves to when the gate is on. */
export const WORKBENCH_LEGACY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  prepare: "trial-balance/review",
  "trial-balance": "trial-balance/review",
  // The engine-named legacy segments keep their existing redirects to the stage slugs (App.tsx); with the gate on, the
  // `prepare` alias above then completes the chain to the one canonical page.
});

export interface WorkbenchNavGroup {
  readonly id: WorkbenchGroupId;
  readonly label: string;
  readonly href: string;
  readonly pages: readonly { readonly id: WorkbenchPageId; readonly label: string; readonly href: string }[];
  /** The existing stage status source for this group (null for the overview). */
  readonly stage: WorkspaceMission | null;
}

export interface WorkbenchNavModel {
  readonly groups: readonly WorkbenchNavGroup[];
  /** Existing modules outside the five groups (for example Reconcile), offered below them, unchanged. */
  readonly modules: readonly NavItem[];
}

const join = (basePath: string, segment: string) => (segment ? `${basePath}/${segment}` : basePath);

/**
 * Regroups the existing navigation items into the workbench. `items` is the output of deriveWorkspaceNavigation after the
 * layout's access filter; nothing absent from it can appear here.
 */
export function deriveWorkbenchNavigation(basePath: string, items: readonly NavItem[], released: ReadonlySet<WorkbenchPageId> = RELEASED_WORKBENCH_PAGES): WorkbenchNavModel {
  const offered = new Map(items.map((i) => [i.id, i] as const));
  const groups: WorkbenchNavGroup[] = [];
  for (const g of WORKBENCH_GROUPS) {
    const gateItem = g.stage === null ? offered.get("overview") : offered.get(g.stage);
    if (!gateItem || gateItem.disabled) continue;
    const pages = g.pages.filter((p) => released.has(p.id)).map((p) => ({ id: p.id, label: p.label, href: join(basePath, p.segment) }));
    if (pages.length === 0) continue;
    groups.push({ id: g.id, label: g.label, href: pages[0].href, pages, stage: g.stage });
  }
  const grouped = new Set<string>(["overview", ...WORKBENCH_GROUPS.flatMap((g) => (g.stage ? [g.stage] : []))]);
  // Modules outside the groups keep the existing model's decision and are re-checked against customer visibility, so a
  // withheld module can never appear here even if a caller passes it.
  const modules = items.filter((i) => !grouped.has(i.id) && i.id !== "overview" && isStageCustomerVisible(i.id as WorkspaceMission));
  return { groups, modules };
}

/** The canonical workbench href for any workspace href (legacy segments mapped; anything else unchanged). */
export function canonicalWorkbenchHref(href: string, basePath: string): string {
  if (!href.startsWith(basePath)) return href;
  const rest = href.slice(basePath.length).replace(/^\//, "");
  const [segment, ...tail] = rest.split("?");
  const target = WORKBENCH_LEGACY_ALIASES[segment];
  if (!target) return href;
  return join(basePath, target) + (tail.length ? `?${tail.join("?")}` : "");
}

/** The page a pathname is showing (null when it is not a workbench page). */
export function activeWorkbenchPage(pathname: string, basePath: string): WorkbenchPageId | null {
  const rest = pathname.startsWith(basePath) ? pathname.slice(basePath.length).replace(/^\/|\/$/g, "") : null;
  if (rest === null) return null;
  for (const g of WORKBENCH_GROUPS) for (const p of g.pages) if (p.segment === rest) return p.id;
  return null;
}
