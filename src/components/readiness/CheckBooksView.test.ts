// @vitest-environment jsdom
/**
 * "Check my books" on the real rendered component, driven by the REAL readiness engine over the pilot's frozen exports
 * (fake transport only): one dominant action; one issue per held check with exact figures and ONE next action; a supported
 * correction is proposed with exact lines in the order the server needs; a person without Prepare is offered no write; nothing
 * is shown as ready that the engine holds.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CheckBooksView } from "./CheckBooksView";
import { axeViolations, click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import type { CorrectionProposal, ReadinessClient, ReadinessStatus } from "@/lib/readiness/client";
import { buildReadinessInput, evaluateReadiness } from "../../../supabase/functions/_shared/readiness/index";
import { pilotFiles } from "@/lib/readiness/pilot/pilotData";
import { pilotAdjustments, pilotExtras, pilotLoadedInputs } from "@/lib/readiness/pilot/pilotRegistrations";
import { PILOT_ACCOUNTS } from "@/lib/readiness/pilot/pilotData";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const C = "22222222-2222-4222-8222-222222222222";
const PERIOD = { start: "2025-07-01", end: "2026-06-30", currency: "TZS", exponent: 2 };

function client(status: ReadinessStatus) {
  const calls: { propose: CorrectionProposal[]; check: number } = { propose: [], check: 0 };
  const c: ReadinessClient = {
    status: async () => status,
    accounts: async () => PILOT_ACCOUNTS.map((a) => ({ key: a.code, code: a.code, name: a.name })),
    start: async () => ({ outcome: "recorded", enabled: true }),
    register: async () => ({ outcome: "recorded" }),
    propose: async (_c, _y, p) => { calls.propose.push(p); return { outcome: "proposed", adjustmentId: `adj-${calls.propose.length}` }; },
    check: async () => { calls.check++; return "recorded"; },
  };
  return { c, calls };
}
const engineStatus = (adjustments?: ReturnType<typeof pilotAdjustments>): ReadinessStatus => {
  const result = evaluateReadiness(buildReadinessInput(pilotLoadedInputs({ files: pilotFiles(), extras: pilotExtras(), adjustments })));
  return { state: "current", period: PERIOD, scope: { rulePackId: "rfr-pilot-ipsas-accrual", rulePackVersion: "1.0.0", facts: pilotExtras().scopeFacts }, run: { id: "run-1", at: "2026-11-08T08:00:00Z", contentSha256: "0".repeat(64), balancesAgree: true, result }, inputs: [] };
};

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const text = () => m!.container.textContent ?? "";
const button = (name: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(name)) as HTMLButtonElement | undefined;

describe("Check my books", () => {
  it("shows ONE dominant action and one issue per held check, each with exact figures and a single next action", async () => {
    const { c } = client(engineStatus());
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"] }));
    await flush();
    expect(m.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
    expect(button("Check my books")).toBeTruthy();
    const articles = [...m.container.querySelectorAll("article")];
    expect(articles.length).toBeGreaterThan(0);
    for (const a of articles) expect((a.textContent!.match(/Next:/g) ?? []).length).toBe(1);
    expect(text()).toMatch(/33,518,793\.00 was charged to .{0,30}expense/);
    expect(text()).toMatch(/Cash does not change/);
    expect(text()).not.toMatch(/SAFISHA|HESABU|KINGA|MAONO/);
    expect(await axeViolations(m.container)).toEqual([]);
  });

  it("proposes the supported correction with exact balanced lines, opening first, in one bundle", async () => {
    const { c, calls } = client(engineStatus());
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"], newRequestId: (() => { let n = 0; return () => `req-${++n}`; })() }));
    await flush();
    click(button("Propose for review")!);
    await flush();
    expect(calls.propose.map((p) => p.correctionId)).toEqual(["corr:opening:payables-food", "corr:food:003/2024.2025"]);
    const [open, food] = calls.propose;
    expect(open.lines).toEqual([{ accountKey: "3050", debitMinor: "3351879300", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "3351879300" }]);
    expect(food.lines).toEqual([{ accountKey: "2000", debitMinor: "3351879300", creditMinor: "0" }, { accountKey: "5607", debitMinor: "0", creditMinor: "3351879300" }]);
    expect(open.bundle).toBe(food.bundle);
    expect(open.bundle).toMatch(/^bundle:food:/);
    expect(text()).toMatch(/2 corrections proposed/);
  });

  it("offers no write to a person without Prepare", async () => {
    const { c, calls } = client(engineStatus());
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["review_close"] }));
    await flush();
    expect(button("Check my books")!.disabled).toBe(true);
    expect(button("Propose for review")!.disabled).toBe(true);
    expect(calls.propose).toEqual([]);
  });

  it("with the corrections approved and every check ready it says so and links the adjusted books to Statements", async () => {
    const { c } = client(engineStatus(pilotAdjustments()));
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"] }));
    await flush();
    expect(text()).toMatch(/Every required check is ready/);
    expect(m.container.querySelector("a[href$='/statements']")).toBeTruthy();
    expect(m.container.querySelectorAll("article")).toHaveLength(0);
  });

  it("a stale evaluation is not presented as current", async () => {
    const s = engineStatus(pilotAdjustments());
    const { c } = client({ ...s, state: "stale" });
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"] }));
    await flush();
    expect(text()).toMatch(/Your books changed since the last check/);
    expect(text()).not.toMatch(/Every required check is ready/);
  });

  it("says plainly when there is no reviewed trial balance, and starts nothing", async () => {
    const { c } = client({ state: "no_authority" });
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"] }));
    await flush();
    expect(text()).toMatch(/no reviewed trial balance/i);
    expect(button("Check my books")).toBeUndefined();
  });

  it("offers to start checking a period that has not opted in", async () => {
    const { c } = client({ state: "not_enabled", period: PERIOD });
    m = mount(h(CheckBooksView, { companyId: C, periodYear: 2026, client: c, allowed: ["prepare_close"] }));
    await flush();
    expect(button("Start checking this period")).toBeTruthy();
    expect(m.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
  });
});
