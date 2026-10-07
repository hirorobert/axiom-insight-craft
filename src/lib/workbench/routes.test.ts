import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { NavItem } from "@/lib/workspace/navigation";
import { WORKBENCH_NAVIGATION_ENABLED } from "./gate";
import {
  RELEASED_WORKBENCH_PAGES, WORKBENCH_GROUPS, WORKBENCH_LEGACY_ALIASES,
  activeWorkbenchPage, canonicalWorkbenchHref, deriveWorkbenchNavigation,
} from "./routes";

const BASE = "/workspace/c1/2025";
const item = (id: NavItem["id"], disabled = false): NavItem => ({ id, label: String(id), href: id === "overview" ? BASE : `${BASE}/${id}`, disabled, inputEvidenceOnly: false });
const src = (p: string) => readFileSync(resolve(__dirname, "../../..", p), "utf8");

describe("workbench gate", () => {
  it("is off, and is a plain source constant (no env, storage, URL or server input)", () => {
    expect(WORKBENCH_NAVIGATION_ENABLED).toBe(false);
    const gate = src("src/lib/workbench/gate.ts");
    expect(gate).toMatch(/^export const WORKBENCH_NAVIGATION_ENABLED = false;$/m);
    expect(gate).not.toMatch(/import\.meta|process\.env|localStorage|sessionStorage|URLSearchParams|document\.cookie|fetch\(|supabase/);
  });
  it("App.tsx registers the canonical routes only under the gate, and keeps every existing route", () => {
    const app = src("src/App.tsx");
    for (const seg of ["trial-balance", "trial-balance/intake", "trial-balance/review"]) {
      expect(app).toMatch(new RegExp(`\\{WORKBENCH_NAVIGATION_ENABLED && <Route path="${seg.replace("/", "\\/")}"`));
    }
    for (const seg of ["prepare", "reconcile", "safisha", "hesabu", "kinga", "analytics", "issues"]) expect(app).toContain(`path="${seg}"`);
    // With the gate off, prepare keeps its previous element exactly; safisha is untouched.
    expect(app).toContain('<StageScopeGate stage="prepare"><PrepareWorkspace /></StageScopeGate>');
    expect(app).toContain('<LegacySubRouteRedirect to="prepare" />');
  });
  it("WorkspaceLayout renders the workbench shell only under the gate; the tab bar is the gate-off branch", () => {
    const layout = src("src/pages/workspace/WorkspaceLayout.tsx");
    expect(layout).toMatch(/\{WORKBENCH_NAVIGATION_ENABLED \? \(\s*<WorkbenchShell/);
    expect(layout).toContain("Stage sub-nav — NO horizontal scroll");
  });
});

describe("five groups, one canonical destination per task", () => {
  it("defines exactly the five groups in order", () => {
    expect(WORKBENCH_GROUPS.map((g) => g.label)).toEqual(["Overview", "Trial Balance", "Close Review", "Financial Statements", "Sign-off & Exports"]);
  });
  it("every page has one unique route segment", () => {
    const segs = WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => p.segment));
    expect(new Set(segs).size).toBe(segs.length);
  });
  it("each legacy alias resolves to exactly one released canonical page", () => {
    for (const [legacy, target] of Object.entries(WORKBENCH_LEGACY_ALIASES)) {
      const page = activeWorkbenchPage(`${BASE}/${target}`, BASE);
      expect(page, legacy).not.toBeNull();
      expect(RELEASED_WORKBENCH_PAGES.has(page!), legacy).toBe(true);
    }
  });
  it("canonicalises legacy hrefs and keeps the query; other hrefs are unchanged", () => {
    expect(canonicalWorkbenchHref(`${BASE}/prepare`, BASE)).toBe(`${BASE}/trial-balance/review`);
    expect(canonicalWorkbenchHref(`${BASE}/prepare?v=4`, BASE)).toBe(`${BASE}/trial-balance/review?v=4`);
    expect(canonicalWorkbenchHref(`${BASE}/reconcile`, BASE)).toBe(`${BASE}/reconcile`);
    expect(canonicalWorkbenchHref("/dashboard", BASE)).toBe("/dashboard");
  });
});

describe("groups derive from the existing navigation model", () => {
  it("Overview and Trial Balance appear when prepare is offered; unreleased groups are absent", () => {
    const m = deriveWorkbenchNavigation(BASE, [item("overview"), item("prepare")]);
    expect(m.groups.map((g) => g.id)).toEqual(["overview", "trial-balance"]);
    expect(m.groups[1].pages.map((p) => p.href)).toEqual([`${BASE}/trial-balance/intake`, `${BASE}/trial-balance/review`]);
  });
  it("a locked or absent prepare stage hides Trial Balance", () => {
    expect(deriveWorkbenchNavigation(BASE, [item("overview"), item("prepare", true)]).groups.map((g) => g.id)).toEqual(["overview"]);
    expect(deriveWorkbenchNavigation(BASE, [item("prepare")]).groups.map((g) => g.id)).toEqual(["trial-balance"]);
  });
  it("Financial Statements and Sign-off stay absent even when a statements item is passed (pages not released)", () => {
    const m = deriveWorkbenchNavigation(BASE, [item("overview"), item("prepare"), item("statements")]);
    expect(m.groups.map((g) => g.id)).not.toContain("financial-statements");
    expect(m.groups.map((g) => g.id)).not.toContain("signoff-exports");
  });
  it("Reconcile is offered below the groups, unchanged; withheld modules never appear even if passed", () => {
    const m = deriveWorkbenchNavigation(BASE, [item("overview"), item("prepare"), item("reconcile"), item("tax"), item("monitor"), item("compliance"), item("filing")]);
    expect(m.modules.map((x) => x.id)).toEqual(["reconcile"]);
  });
});
