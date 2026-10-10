// @vitest-environment jsdom
/**
 * Workbench activation (WORKBENCH_NAVIGATION_ENABLED = true): the real components and the real navigation model, with
 * only the network edge (the Supabase client) doubled.
 *
 *   routes      legacy segments resolve to one canonical page and keep the report version (?v=);
 *   navigation  derived from the existing model: Overview and Trial Balance (Intake, Account review) for a
 *               FINANCIAL_STATEMENTS engagement; withheld and unreleased modules absent; links keep ?v=;
 *   intake      the real Trial balance › Intake page: currency/period setup (BHD with an adjacent prior period), manual
 *               layout check against the whole file (a three-decimal BHD report), confirmation with the expected
 *               number, the new check through the existing re-check path, and the link to the single uploader keeping
 *               the workbench context; no axe violations;
 *   review      Account review is the existing Prepare workspace behind the same scope gate.
 */
import { act, createElement as h, type ReactNode } from "react";
import fs from "node:fs";
import path from "node:path";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { data: unknown; error: unknown };
const calls: { kind: string; name: string; args: unknown }[] = [];
let invokeImpl: (name: string, body: Record<string, unknown>) => Answer = () => ({ data: null, error: null });
let rpcImpl: (name: string, args: Record<string, unknown>) => Answer = () => ({ data: null, error: null });

vi.mock("@/integrations/supabase/client", () => {
  const query = (table: string) => {
    const result = (): Answer => {
      if (table === "layout_templates") return { data: [], error: null };
      if (table === "trial_balance_uploads") return { data: { source_file_hash: "f".repeat(64) }, error: null };
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => result();
    q.then = (ok: (v: Answer) => unknown) => Promise.resolve(result()).then(ok);
    return q;
  };
  return {
    supabase: {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push({ kind: "rpc", name, args }); return rpcImpl(name, args); }),
      from: vi.fn((table: string) => query(table)),
      functions: { invoke: vi.fn(async (name: string, opts: { body: Record<string, unknown> }) => { calls.push({ kind: "invoke", name, args: opts.body }); return invokeImpl(name, opts.body); }) },
      auth: { getSession: vi.fn(async () => ({ data: { session: null } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
    },
  };
});
vi.mock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: vi.fn(async () => "token") }));

import { WORKBENCH_NAVIGATION_ENABLED } from "./gate";
import { WorkbenchAliasRedirect } from "@/components/workbench/WorkbenchAliasRedirect";
import { WorkbenchNav } from "@/components/workbench/WorkbenchNav";
import { deriveWorkbenchNavigation } from "./routes";
import { deriveWorkspaceNavigation } from "@/lib/workspace/navigation";
import { projectMandate } from "@/lib/workspace/mandate";
import { STAGE_SEQUENCE } from "@/lib/workspace/stageMetadata";
import type { MissionState, WorkspaceMission } from "@/lib/workspace/types";
import { WorkspaceContext } from "@/contexts/WorkspaceContext";
import TrialBalanceIntake from "@/pages/workspace/TrialBalanceIntake";
import { axeViolations, click, key, mount, type Mounted } from "./testkit/dom";

const ROOT = path.resolve(__dirname, "../../..");
let m: Mounted | null = null;
beforeEach(() => { calls.length = 0; });
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const byText = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement;
const field = (label: string) => document.getElementById([...document.querySelectorAll("label")].find((x) => x.textContent === label)!.htmlFor) as HTMLInputElement & HTMLSelectElement;
const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => act(() => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
});

function Probe() {
  const l = useLocation();
  return h("p", { "data-testid": "at" }, `${l.pathname}${l.search}`);
}

describe("the gate is on", () => {
  it("WORKBENCH_NAVIGATION_ENABLED is the reviewed constant true; withheld modules stay hidden", () => {
    expect(WORKBENCH_NAVIGATION_ENABLED).toBe(true);
    const avail = fs.readFileSync(path.join(ROOT, "src/lib/workspace/moduleAvailability.ts"), "utf8");
    expect(avail).toMatch(/export const UNPROVEN_MODULES_CUSTOMER_VISIBLE: boolean = false;/);
  });
});

describe("routes: one canonical destination, context preserved", () => {
  for (const [segment, from] of [["prepare", "/workspace/c1/2025/prepare?v=3"], ["trial-balance", "/workspace/c1/2025/trial-balance?v=3"]] as const) {
    it(`/${segment} → trial-balance/review, keeping ?v=3`, () => {
      m = mount(h(MemoryRouter, { initialEntries: [from] },
        h(Routes, null,
          h(Route, { path: `/workspace/:companyId/:periodYear/${segment}`, element: h(WorkbenchAliasRedirect, { segment }) }),
          h(Route, { path: "/workspace/:companyId/:periodYear/trial-balance/review", element: h(Probe) }))));
      expect(document.querySelector("[data-testid=at]")?.textContent).toBe("/workspace/c1/2025/trial-balance/review?v=3");
    });
  }
  it("App.tsx: Intake renders the Intake page and Account review the existing Prepare workspace, both behind the Prepare scope gate", () => {
    const app = fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
    expect(app).toContain('{WORKBENCH_NAVIGATION_ENABLED && <Route path="trial-balance/intake" element={<StageScopeGate stage="prepare"><Suspense fallback={null}><TrialBalanceIntake /></Suspense></StageScopeGate>} />}');
    expect(app).toContain('{WORKBENCH_NAVIGATION_ENABLED && <Route path="trial-balance/review" element={<StageScopeGate stage="prepare"><PrepareWorkspace /></StageScopeGate>} />}');
  });
});

describe("navigation: derived from the existing model; unavailable modules hidden", () => {
  const missions = (): Record<WorkspaceMission, MissionState> =>
    Object.fromEntries(STAGE_SEQUENCE.map((s) => [s, { status: "in_progress", label: s, summary: "", href: `/x/${s}` }])) as Record<WorkspaceMission, MissionState>;
  it("a Trial Balance Review engagement shows Overview and Trial Balance (Intake, Account review) only; every link keeps ?v=3", async () => {
    const base = "/workspace/c1/2025";
    const items = deriveWorkspaceNavigation({ basePath: base, scopeDeclared: true, missionViews: projectMandate(missions(), { engagementId: "e", granted: ["FINANCIAL_STATEMENTS"] }) });
    const model = deriveWorkbenchNavigation(base, items);
    m = mount(h(MemoryRouter, null, h(WorkbenchNav, { model, activePage: "tb-intake", reportVersion: 3, groupStatus: () => null })));
    const text = m.container.textContent ?? "";
    expect(model.groups.map((g) => g.label)).toEqual(["Overview", "Trial Balance"]);
    for (const hidden of ["Close Review", "Findings", "Adjustments", "Financial Statements", "Notes", "Sign-off", "Exports", "Tax", "Compliance", "Filing", "Monitor"]) expect(text).not.toContain(hidden);
    const hrefs = [...m.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`${base}/trial-balance/intake?v=3`);
    expect(hrefs).toContain(`${base}/trial-balance/review?v=3`);
    expect(hrefs.every((x) => x?.endsWith("?v=3"))).toBe(true);
    expect(await axeViolations(m.container)).toEqual([]);
  });
});

describe("intake: the real page, end to end against the server contracts", () => {
  const INSPECT = {
    status: "ok", kind: "csv", sourceFileHash: "f".repeat(64), currentConfirmationNo: 0,
    sheets: [{ name: null, rowCount: 3, preview: [{ rowNumber: 1, cells: ["Code", "Name", "Soll", "Haben"] }, { rowNumber: 2, cells: ["1000", "Bank", "1.234,567", null] }, { rowNumber: 3, cells: ["3000", "Capital", null, "1.234,567"] }],
      suggestion: { headerRow: 1, columns: { account_code: "Code", account_name: "Name" } }, numberFormats: { consistent: ["dot_comma"], ambiguous: false, textCells: 2 } }],
  };
  const REPORT = { layoutFits: true, profileSha256: "a".repeat(64), resolvedProfileSha256: "b".repeat(64), sourceFileHash: "f".repeat(64), currency: "BHD",
    issues: [], lineageSummary: { rowsRead: 3 }, totals: { debit: "1234.567", credit: "1234.567", difference: "0.000" }, accounts: 2,
    rows: [[1, "header", null], [2, "account", "code:1000"], [3, "account", "code:3000"]] };
  const workspace = (refreshUpload = vi.fn()) => ({ companyId: "c1", periodYear: 2025, upload: { id: "u1", file_name: "tb.csv" }, refreshUpload }) as never;
  function page(children: ReactNode) {
    return h(MemoryRouter, { initialEntries: ["/workspace/c1/2025/trial-balance/intake?v=3"] },
      h(Routes, null, h(Route, { path: "/workspace/:companyId/:periodYear/trial-balance/intake", element: children })));
  }

  it("period setup, whole-file layout check (BHD, three decimals), confirmation, the new check and the uploader link — in order", async () => {
    rpcImpl = (name) => name === "open_engagement_with_period"
      ? { data: { outcome: "opened", engagementId: "e", periodId: "p", priorPeriodId: "pp", periodYear: 2025, created: true, granted: ["FINANCIAL_STATEMENTS"] }, error: null }
      : name === "tbu_request_reprocess" ? { data: { outcome: "accepted", code: "ACCEPTED", upload_id: "u1", operation_id: "op", invalidated_certification_id: null }, error: null }
      : { data: null, error: null };
    invokeImpl = (name, body) => {
      if (name === "process-trial-balance") return { data: { status: "complete" }, error: null };
      if (body.action === "inspect") return { data: INSPECT, error: null };
      if (body.action === "validate") return { data: { status: "validated", report: REPORT }, error: null };
      if (body.action === "confirm") return { data: { status: "confirmed", confirmationId: "c", confirmationNo: 1, replay: false, unchanged: false, report: REPORT }, error: null };
      return { data: null, error: null };
    };
    const refreshUpload = vi.fn();
    m = mount(page(h(WorkspaceContext.Provider, { value: workspace(refreshUpload) }, h(TrialBalanceIntake))));
    await flush();

    // 1. Reporting period: explicit dates, BHD, and the adjacent prior period. No default currency.
    expect(field("Reporting currency").value).toBe("");
    set(field("Start date"), "2024-07-01"); set(field("End date"), "2025-06-30"); set(field("Reporting currency"), "BHD");
    click(document.getElementById(field("Also set up the prior period (for comparatives)").id)!);
    set(field("Prior start date"), "2023-07-01"); set(field("Prior end date"), "2024-06-30");
    click(byText(/Set up the period/)); await flush();
    expect(calls.find((c) => c.name === "open_engagement_with_period")?.args).toMatchObject({
      p_company_id: "c1", p_period_start: "2024-07-01", p_period_end: "2025-06-30", p_reporting_currency: "BHD",
      p_capabilities: ["FINANCIAL_STATEMENTS"], p_prior_start: "2023-07-01", p_prior_end: "2024-06-30" });
    expect(document.body.textContent).toContain("Reporting period 2024-07-01 to 2025-06-30 (BHD) is set up.");

    // 2. Manual layout: the server's reading pre-fills code/name and the unambiguous number format; the person adds
    //    Debit/Credit and checks the WHOLE file — the report shows three-decimal BHD totals and every row.
    set(field("Debit"), "Soll"); set(field("Credit"), "Haben");
    click(byText(/Check against the whole file/)); await flush();
    expect(calls.find((c) => c.name === "trial-balance-layout" && (c.args as { action: string }).action === "validate")?.args)
      .toMatchObject({ uploadId: "u1", layout: { numberFormat: "dot_comma", columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben" } } });
    const panel = document.querySelector("aside[role=complementary]")!;
    expect(panel.textContent).toContain("1234.567 BHD");
    expect(panel.textContent).toContain("0.000");
    key(document.activeElement!, "Escape");

    // 3. Confirmation: the dialog states the consequence; the request carries the expected confirmation number.
    click(byText(/Confirm layout for this file/));
    expect(document.body.textContent).toContain("A current result for it will need a new check.");
    click(byText(/^Confirm layout$/)); await flush();
    expect(calls.find((c) => (c.args as { action?: string }).action === "confirm")?.args).toMatchObject({ uploadId: "u1", expectedConfirmationNo: 0, templateId: null });

    // 4. The new check uses the existing re-check path with one operation id.
    click(byText(/Run a new check with this layout/)); await flush();
    const rr = calls.find((c) => c.name === "tbu_request_reprocess")!.args as { p_operation_id: string };
    expect(calls.find((c) => c.name === "process-trial-balance")?.args).toEqual({ uploadId: "u1", clientRequestId: rr.p_operation_id });
    expect(refreshUpload).toHaveBeenCalled();

    // 5. The single uploader keeps the workbench context.
    const link = [...document.querySelectorAll("a")].find((a) => /Upload or replace the file/.test(a.textContent ?? ""))!;
    expect(link.getAttribute("href")).toBe("/workspace/c1/2025/trial-balance/review?v=3");
    expect(await axeViolations(m.container)).toEqual([]);
  });

  it("a backend without the layout function: the page says manual layouts are unavailable, and nothing errors", async () => {
    invokeImpl = () => ({ data: null, error: { name: "FunctionsHttpError", context: new Response(JSON.stringify({ message: "Function not found" }), { status: 404 }) } });
    m = mount(page(h(WorkspaceContext.Provider, { value: workspace() }, h(TrialBalanceIntake))));
    await flush();
    expect(document.body.textContent).toContain("Manual layouts are not available yet. The automatic reading of your file still works as before.");
  });
  it("a file the automatic reading settled: the file summary leads (columns, the detected format with the file's own examples); the editor opens only on request", async () => {
    const settled = { ...INSPECT, sheets: [{ ...INSPECT.sheets[0], suggestion: { headerRow: 1, columns: { account_code: "Code", account_name: "Name", debit: "Soll", credit: "Haben" } } }] };
    invokeImpl = (_name, body) => (body.action === "inspect" ? { data: settled, error: null } : { data: null, error: null });
    m = mount(page(h(WorkspaceContext.Provider, { value: workspace() }, h(TrialBalanceIntake))));
    await flush();
    const summary = document.querySelector('[data-testid="layout-summary"]')!;
    expect(summary.textContent).toContain("Read automatically");
    expect(summary.textContent).toContain("“Soll”");
    expect(document.querySelector('[data-testid="layout-number-format"]')!.textContent).toMatch(/1\.234\.567,89.*“1\.234,567”/);
    expect(byText(/Check against the whole file/)).toBeUndefined();
    click(document.querySelector('[data-testid="layout-change"]')!); await flush();
    // In the editor the detected format leads; the seven alternatives are one click away, not the first thing shown.
    expect(document.querySelector('[data-testid="number-format-detected"] details')).not.toBeNull();
    expect(byText(/Check against the whole file/)).toBeDefined();
  });
  it("a file whose check failed opens the editor directly", async () => {
    const settled = { ...INSPECT, sheets: [{ ...INSPECT.sheets[0], suggestion: { headerRow: 1, columns: { account_code: "Code", account_name: "Name", debit: "Soll", credit: "Haben" } } }] };
    invokeImpl = (_name, body) => (body.action === "inspect" ? { data: settled, error: null } : { data: null, error: null });
    const ws = { companyId: "c1", periodYear: 2025, upload: { id: "u1", file_name: "tb.csv", status: "blocked", is_valid: false }, refreshUpload: vi.fn() } as never;
    m = mount(page(h(WorkspaceContext.Provider, { value: ws }, h(TrialBalanceIntake))));
    await flush();
    expect(document.querySelector('[data-testid="layout-summary"]')).toBeNull();
    expect(byText(/Check against the whole file/)).toBeDefined();
  });
});
