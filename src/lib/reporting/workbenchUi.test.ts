// @vitest-environment jsdom
// The reporting workbench container against a scripted server: the one next action, recovery from a read failure, the
// role-dependent controls and accessibility. The real-database journey is scripts/browser-acceptance/reportingJourney.mjs.
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportingWorkbench } from "@/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "@/components/reporting/shared";
import { composition } from "@/lib/statements/compositionFixture";
import { axeViolations, click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import type { ReportingDb } from "./signoff";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });

const H = (c: string) => c.repeat(64);
const NOTES = { state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"),
  requirements: [{ requirementId: "smes.note.policies", kind: "DISCLOSURE", blocking: true, status: "missing" }] };
const CMP = { state: "evaluated", statusSha256: H("e"), comparative: { contract: "fs-comparatives-status/1", periodYear: 2026, state: "approved", composedComparativeState: "available", required: true,
  firstPeriodDeclared: false, comparativeSha256: H("f"), compositionSha256: H("b"), approval: null, blockers: [] } };

function server(over: Partial<Record<string, () => unknown>> = {}): ReportingDb & { calls: string[] } {
  const calls: string[] = [];
  const rpc: Record<string, () => unknown> = {
    fs_statement_composition: () => composition, fs_notes_status: () => NOTES, fs_comparatives_status: () => CMP, fs_list_saved_versions: () => [], ...over,
  };
  return {
    calls,
    rpc: async (fn) => { calls.push(fn); const f = rpc[fn]; if (!f) return { data: null, error: { message: `unexpected ${fn}` } }; try { return { data: f(), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
    select: async (t) => { calls.push(`select:${t}`); return { data: [], error: null }; },
  };
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (db: ReportingDb, page: ReportingPage, allowed: string[] = ["prepare_close"]) => {
  m = mount(h(MemoryRouter, null, h(ReportingWorkbench, { page, companyId: "c1", periodYear: 2026, legalName: "Synthetic SME Limited", db, allowed, reportVersion: 2,
    hrefFor: (p: ReportingPage, v: number | null) => `/${p}${v ? `?v=${v}` : ""}` })));
  await settle();
};

describe("the reporting workbench container", () => {
  it("shows ONE next action, from the server's states, linking to the page that owns it with the version kept", async () => {
    await render(server(), "fs-statements");
    const na = document.querySelectorAll('[data-testid="next-action"]');
    expect(na).toHaveLength(1);
    expect(na[0].textContent).toContain("Complete 1 note requirement");
    expect(na[0].querySelector("a")!.getAttribute("href")).toBe("/fs-notes?v=2");
    expect(await axeViolations(document.body)).toEqual([]);
  });
  it("on its own page the next action is stated, not linked", async () => {
    await render(server(), "fs-notes");
    expect(document.querySelector('[data-testid="next-action"] a')).toBeNull();
  });
  it("a read failure shows what failed and a retry; the retry reads again and recovers", async () => {
    let fail = true;
    const db = server({ fs_statement_composition: () => { if (fail) throw new Error("connection reset"); return composition; } });
    await render(db, "fs-statements");
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("connection reset");
    fail = false;
    click([...alert.querySelectorAll("button")].find((b) => b.textContent === "Try again")!);
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Statement of Financial Position");
  });
  it("controls follow the server-reported capabilities: a viewer sees no assignment, wording or sign-off control", async () => {
    const withUnassigned = { ...composition, accountsNotPresented: [{ period: "current", accountKey: "9999", accountCode: "9999", accountName: "Suspense", classification: "current_assets", status: "unassigned", lineId: null }] };
    await render(server({ fs_statement_composition: () => withUnassigned }), "fs-statements", []);
    expect(document.querySelector('[data-testid="not-presented"] select')).toBeNull();
    expect(document.body.textContent).toContain("A preparer assigns presentation lines.");
  });
  it("reads only: the container itself calls no write function", async () => {
    const db = server();
    await render(db, "fs-statements");
    expect(db.calls.filter((c) => /assign|record|decide|approve|commit|set_publication|propose|bridge/.test(c))).toEqual([]);
  });
});
