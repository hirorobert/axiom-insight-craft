// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, click, axeViolations, type Mounted } from "@/lib/workbench/testkit/dom";
import { ManagementContext } from "@/components/account/managementState";
import { WORKSPACE_SETTINGS_SAVED } from "@/lib/workspace/settingsContinuity";
const fixture = vi.hoisted(() => ({ query: vi.fn(), rpc: vi.fn(), register: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: (_: string, id: string) => fixture.query(id) }) }),
  rpc: (...args: unknown[]) => fixture.rpc(...args),
} }));
import { supabase } from "@/integrations/supabase/client";
import { ReportingPeriodHandoff } from "./ReportingPeriodHandoff";
import { PeriodSetup } from "@/components/workbench/intake/PeriodSetup";
const periods = [
  { id: "p25", reporting_start: "2025-01-01", reporting_end: "2025-12-31", reporting_currency: "TZS", prior_period_id: "p24" },
  { id: "p24", reporting_start: "2024-01-01", reporting_end: "2024-12-31", reporting_currency: "TZS", prior_period_id: null },
];
let ui: Mounted | undefined;
const flush = async () => { for (let i=0; i<8; i++) await act(async () => { await Promise.resolve(); }); };
beforeEach(() => {
  fixture.query.mockReset().mockResolvedValue({ data: periods, error: null });
  fixture.rpc.mockReset().mockResolvedValue({ data: { outcome: "not_eligible", currency: "TZS", block: { code: "ACCEPTED_CERTIFICATION" } }, error: null });
  fixture.register.mockReset();
});
afterEach(() => { ui?.unmount(); ui=undefined; document.body.innerHTML=""; });
const card = (companyId="company-a", periodYear=2025) => h(MemoryRouter, null, h(ReportingPeriodHandoff, { companyId, periodYear }));
const form = () => h(ManagementContext.Provider, { value: { origin: null, register: fixture.register } }, h(PeriodSetup, { companyId:"company-a", periodYear:2025, client:supabase as never }));
describe("prior period settings regression", () => {
  it("reopening shows both saved prior dates and starts clean; no setup write", async () => {
    ui=mount(form()); await flush();
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((x) => x.value)).toEqual(["2025-01-01","2025-12-31","2024-01-01","2024-12-31"]);
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(fixture.register.mock.calls.filter((x) => x[1]).at(-1)?.[1]).toMatchObject({ dirty:false, busy:false });
    expect(fixture.rpc.mock.calls.some((x) => x[0]==="open_engagement_with_period")).toBe(false);
    ui.unmount(); ui=mount(form()); await flush();
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="date"]')].at(-1)?.value).toBe("2024-12-31");
  });
  it("saving a linked period sends the exact saved prior dates instead of silently omitting the prior", async () => {
    fixture.rpc.mockImplementation(async (name: string) => ({ error:null, data:name === "open_engagement_with_period"
      ? {outcome:"opened",engagementId:"e",periodId:"p25",priorPeriodId:"p24",periodYear:2025,created:false,granted:["FINANCIAL_STATEMENTS"]}
      : {outcome:"not_eligible",currency:"TZS",block:{code:"ACCEPTED_CERTIFICATION"}} }));
    ui=mount(form());await flush();click(document.querySelector('button[type="submit"]')!);await flush();
    expect(fixture.rpc).toHaveBeenCalledWith("open_engagement_with_period", expect.objectContaining({p_prior_start:"2024-01-01",p_prior_end:"2024-12-31",p_period_start:"2025-01-01",p_period_end:"2025-12-31"}));
  });
  it("a linked prior record hidden or absent blocks saving rather than offering blank dates as saved state", async () => {
    fixture.query.mockResolvedValue({ data: [periods[0]], error:null }); ui=mount(form()); await flush();
    expect(document.body.textContent).toContain("could not be read");
    expect(document.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
  });
});
describe("in-flow period navigation", () => {
  it("states actual dates/currency and links to FY2024; carries no FY2025 upload or version query", async () => {
    ui=mount(card()); await flush();
    expect(document.body.textContent).toContain("2025-01-01 to 2025-12-31 · TZS");
    expect(document.querySelector('a[href="/workspace/company-a/2024/trial-balance/review"]')).not.toBeNull();
    expect(document.body.textContent).toContain("does not move your current file");
    expect(await axeViolations(ui.container)).toEqual([]);
  });
  it("the prior-year page offers a return to the actual linked following year", async () => {
    ui=mount(card("company-a",2024)); await flush();
    expect(document.querySelector('a[href="/workspace/company-a/2025/trial-balance/review"]')?.textContent).toBe("Return to FY2025 trial balance");
  });
  it("a failed read says unavailable; retry reads again instead of guessing a prior year", async () => {
    fixture.query.mockResolvedValueOnce({ data:null, error:{code:"offline"} });ui=mount(card());await flush();
    expect(document.body.textContent).toContain("could not be read");
    expect(document.querySelector('a[href*="/2024/"]')).toBeNull();
    click(document.querySelector("button")!);await flush();
    expect(document.querySelector('a[href*="/2024/"]')).not.toBeNull();
  });
  it("a Settings save re-reads the periods for this company; another company event does nothing", async () => {
    ui=mount(card());await flush();
    await act(async () => window.dispatchEvent(new CustomEvent(WORKSPACE_SETTINGS_SAVED,{detail:{companyId:"other"}})));
    expect(fixture.query).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new CustomEvent(WORKSPACE_SETTINGS_SAVED,{detail:{companyId:"company-a"}})));await flush();
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });
  it("an old company's delayed read never creates a link in the next company's workspace", async () => {
    let resolve!: (v: unknown) => void;
    fixture.query.mockImplementationOnce(() => new Promise((r) => {resolve=r;}));
    ui=mount(card());ui.rerender(card("company-b"));await flush();
    await act(async () => resolve({data:periods,error:null}));await flush();
    expect(document.querySelector('a[href*="company-a"]')).toBeNull();
    expect(document.querySelector('a[href*="company-b/2024"]')).not.toBeNull();
  });
});
