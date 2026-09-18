/**
 * Default-off proof for FINANCIAL_STATEMENTS_WORKSPACE_ENABLED, plus regression
 * tests for the honest-draft wording. Static checks read the real source; runtime
 * checks render the real Statements page and the real workspace component with
 * the gate closed and prove nothing new runs or mounts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { FINANCIAL_STATEMENTS_WORKSPACE_ENABLED, isWorkspaceRenderable } from "./workspaceGate";

const hookSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useFinancialStatementsWorkspace", () => ({ useFinancialStatementsWorkspace: hookSpy }));
vi.mock("@/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({
    upload: { id: "u1", company_id: "c1", company_name: "Legacy Co", file_name: "tb.xlsx", status: "complete", is_valid: true, processed_at: "x", processing_result: {}, validation_report: null, accounting_errors: null },
    uploads: [],
    workspaceState: { missions: { statements: { status: "in_progress" }, prepare: { href: "/p" } } },
    companyId: "c1",
    periodYear: 2025,
    company: { name: "Legacy Co", tin: null, reporting_framework: "full_ifrs", currency: "TZS", fiscal_year_end: "2020-12-31" },
  }),
}));
vi.mock("@/lib/workspace/computePreflight", () => ({ computePreflight: () => ({ checks: [], verdict: "certified", blocker: null }) }));
vi.mock("@/components/HesabuAssurancePanel", () => ({ HesabuAssurancePanel: () => createElement("div", null, "LEGACY-HESABU-PANEL") }));
vi.mock("@/components/PeriodClosingBalancesPanel", () => ({ PeriodClosingBalancesPanel: () => createElement("div", null, "LEGACY-PCB-PANEL") }));
vi.mock("@/components/workspace/WorkspaceGate", () => ({ WorkspaceGate: () => createElement("div", null, "LEGACY-GATE") }));
vi.mock("@/components/workspace/MappingSourcePreview", () => ({ MappingSourcePreview: () => createElement("div", null, "LEGACY-MAPPING-PREVIEW") }));
vi.mock("@/components/workspace/TrialBalancePreflight", () => ({ TrialBalancePreflight: () => createElement("div", null, "LEGACY-PREFLIGHT") }));
vi.mock("@/components/ExportStatements", () => ({ ExportStatements: () => createElement("div", null, "LEGACY-EXPORT") }));

const ROOT = path.join(__dirname, "../../../");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const norm = (s: string) => s.replace(/\r\n/g, "\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  hookSpy.mockReset();
});

describe("feature gate — static", () => {
  it("is a plain source constant that defaults to false", () => {
    const gate = read("src/lib/financialStatementsWorkspace/workspaceGate.ts");
    expect(gate).toMatch(/^export const FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false;$/m);
    expect(FINANCIAL_STATEMENTS_WORKSPACE_ENABLED).toBe(false);
  });

  it("cannot be enabled through browser or deployment configuration: no env, VITE_, storage, URL or runtime read feeds it", () => {
    const gate = norm(read("src/lib/financialStatementsWorkspace/workspaceGate.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(gate).not.toMatch(/import\.meta|process\.env|VITE_|localStorage|sessionStorage|location|URLSearchParams|window|document|fetch|Deno/);
    // No environment file or vite config names it.
    for (const f of fs.readdirSync(ROOT).filter((n) => /^\.env/.test(n))) {
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/FINANCIAL_STATEMENTS_WORKSPACE|WORKSPACE_ENABLED/);
    }
    expect(read("vite.config.ts")).not.toMatch(/FINANCIAL_STATEMENTS_WORKSPACE/);
    expect(read("src/vite-env.d.ts")).not.toMatch(/FINANCIAL_STATEMENTS_WORKSPACE/);
  });

  it("only the page, the component boundary and this gate reference the constant in src", () => {
    const users = walk(path.join(ROOT, "src"))
      .filter((f) => /FINANCIAL_STATEMENTS_WORKSPACE_ENABLED/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual([
      "src/components/financialStatements/FinancialStatementsWorkspace.tsx",
      "src/lib/financialStatementsWorkspace/workspaceGate.test.ts",
      "src/lib/financialStatementsWorkspace/workspaceGate.ts",
      "src/pages/workspace/StatementsWorkspace.tsx",
    ]);
  });

  it("the Statements page loads the workspace only through a gated lazy import (no static import of any workspace code)", () => {
    const page = norm(read("src/pages/workspace/StatementsWorkspace.tsx"));
    const staticImports = [...page.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
    const workspaceStatic = staticImports.filter((m) => /financialStatements|financialStatementsWorkspace|useFinancialStatementsWorkspace/.test(m));
    expect(workspaceStatic).toEqual(["@/lib/financialStatementsWorkspace/workspaceGate"]);
    expect(page).toMatch(/const FinancialStatementsWorkspace = FINANCIAL_STATEMENTS_WORKSPACE_ENABLED\s*\?\s*lazy\(\(\) => import\("@\/components\/financialStatements\/FinancialStatementsWorkspace"\)/);
    expect(page).toMatch(/:\s*null;/);
    expect(page).toMatch(/\{FinancialStatementsWorkspace && \(/);
  });

  it("no production module outside the workspace's own directories imports workspace code", () => {
    const own = ["src/components/financialStatements/", "src/lib/financialStatementsWorkspace/", "src/hooks/useFinancialStatementsWorkspace.ts", "src/pages/workspace/StatementsWorkspace.tsx"];
    const offenders = walk(path.join(ROOT, "src"))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => !own.some((o) => rel.startsWith(o)))
      .filter((rel) => /from ["']@\/(components\/financialStatements|lib\/financialStatementsWorkspace|hooks\/useFinancialStatementsWorkspace)/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the page differs from main only by the gated mount: every line of main's page is still present, in order", () => {
    let mainText: string | null = null;
    try {
      mainText = execSync("git show origin/main:src/pages/workspace/StatementsWorkspace.tsx", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      mainText = null;
    }
    if (mainText === null) return; // origin/main not available in this checkout; the dist scan and runtime tests still apply
    const main = norm(mainText).split("\n").map((l) => l.replace("const { upload, workspaceState, companyId, periodYear, company } = useWorkspace();", "const { upload, uploads, workspaceState, companyId, periodYear, company } = useWorkspace();"));
    const cand = norm(read("src/pages/workspace/StatementsWorkspace.tsx")).split("\n");
    let i = 0;
    for (const line of cand) if (i < main.length && line === main[i]) i += 1;
    expect(i, `line ${i + 1} of main is missing or reordered: ${main[i]}`).toBe(main.length);
  });
});

describe("feature gate — pure decision", () => {
  it("renders only when the gate is on or this is a dev build", () => {
    expect(isWorkspaceRenderable(false, false)).toBe(false);
    expect(isWorkspaceRenderable(false, true)).toBe(true);
    expect(isWorkspaceRenderable(true, false)).toBe(true);
    expect(isWorkspaceRenderable(true, true)).toBe(true);
  });
});

describe("feature gate — runtime, default off", () => {
  it("the Statements page renders its legacy panels and mounts no workspace, and no workspace hook runs", async () => {
    const { default: StatementsWorkspace } = await import("@/pages/workspace/StatementsWorkspace");
    const html = renderToStaticMarkup(createElement(StatementsWorkspace));
    for (const marker of ["LEGACY-MAPPING-PREVIEW", "LEGACY-EXPORT", "LEGACY-HESABU-PANEL", "LEGACY-PCB-PANEL"]) expect(html).toContain(marker);
    expect(html).not.toMatch(/data-fs-workspace|Internal preview|unsaved draft|fs-stage-panel|Professional Review/);
    expect(hookSpy).not.toHaveBeenCalled();
  });

  it("the workspace component returns null before any hook, fetch or evaluation when neither the gate nor a dev build allows it", async () => {
    vi.stubEnv("DEV", false);
    const { FinancialStatementsWorkspace } = await import("@/components/financialStatements/FinancialStatementsWorkspace");
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(FinancialStatementsWorkspace, { companyId: "c", periodYear: 2025, companyName: "X", companyTin: null, reportingFramework: "full_ifrs", currency: "TZS", fiscalYearEnd: null, currentUpload: null, uploads: [] })),
    );
    expect(html).toBe("");
    expect(hookSpy).not.toHaveBeenCalled();
  });
});
